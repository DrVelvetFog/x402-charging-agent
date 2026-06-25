/**
 * The car's agent: the buyer half of x402, plus a spend policy and the wait for
 * the battery to fill. Adapted from x402-sui-stack's buyer.ts.
 *
 * It reads the price off the 402, refuses if it exceeds its budget, signs the
 * exact payment with the car's own key, re-requests to start the session, then
 * polls the vehicle until charging completes. This is what an autonomous vehicle
 * does to buy energy with no human in the loop.
 */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Requirements, buildPayment, encodeHeader, decodeHeader, short } from "./lib.js";

export type ChargeResult = {
  requirements: Requirements;
  session: any;
  digest: string;
  settle: any;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pay for and start a charge session. Returns once the car is charging. */
export async function buyCharge(
  chargerUrl: string,
  client: SuiJsonRpcClient,
  payer: Ed25519Keypair,
  budgetAtomic: bigint,
  onStep: (msg: string) => void = () => {},
): Promise<ChargeResult> {
  // 1. unpaid request -> 402 + terms
  const first = await fetch(chargerUrl);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const header = first.headers.get("payment-required");
  const body: any = header ? decodeHeader(header) : await first.json();
  const requirements: Requirements = body.accepts[0];
  onStep(
    `402 Payment Required — ${requirements.amount} atomic of ${short(requirements.asset)} to ${short(requirements.payTo)}`,
  );

  // 2. spend policy: the agent decides whether the price is acceptable
  if (BigInt(requirements.amount) > budgetAtomic) {
    throw new Error(`price ${requirements.amount} exceeds agent budget ${budgetAtomic} — declining`);
  }
  onStep(`price within budget (${budgetAtomic} atomic) — approving`);

  // 3. build + sign the exact payment (the car holds the keys, not the facilitator)
  const payload = await buildPayment(
    client,
    payer,
    requirements.payTo,
    BigInt(requirements.amount),
    requirements.asset,
  );
  onStep(`signed payment from car wallet ${short(payer.toSuiAddress())}`);

  // 4. retry with the signed payment -> charger settles and starts the session
  const paymentPayload = { x402Version: 2, resource: body.resource, accepted: requirements, payload };
  const paid = await fetch(chargerUrl, { headers: { "payment-signature": encodeHeader(paymentPayload) } });
  if (paid.status !== 200) throw new Error(`payment rejected (${paid.status}): ${await paid.text()}`);
  const respHeader = paid.headers.get("payment-response");
  const settle: any = respHeader ? decodeHeader(respHeader) : {};
  const session = await paid.json();
  onStep(`200 OK — settled on Sui (digest ${short(settle.transaction)}), charging started`);

  return { requirements, session, digest: settle.transaction, settle };
}

/** Poll the vehicle's state of charge until the session completes. */
export async function waitForCharge(
  vehicleUrl: string,
  vin: string,
  onTick: (soc: number, state: string) => void = () => {},
  timeoutMs = 30_000,
): Promise<{ soc: number; state: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const r: any = await (await fetch(`${vehicleUrl}/api/1/vehicles/${vin}/vehicle_data`)).json();
    const cs = r?.response?.charge_state ?? {};
    const soc = Number(cs.battery_level ?? 0);
    const state = String(cs.charging_state ?? "Unknown");
    if (soc !== last) {
      onTick(soc, state);
      last = soc;
    }
    if (state === "Complete" || state === "Stopped" || state === "Disconnected") return { soc, state };
    await sleep(700);
  }
  throw new Error("charge did not complete before timeout");
}
