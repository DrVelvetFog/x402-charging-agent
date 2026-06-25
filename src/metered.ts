/**
 * Phase 2 — usage-metered charging over the x402 `upto` model.
 *
 * Unlike Phase 1 (fixed price, pay-then-charge), a metered session pre-authorizes
 * a *ceiling*, delivers energy, meters the kWh, then settles the *actual* amount
 * (<= ceiling) on-chain — exactly like a fuel-pump pre-auth. This is the x402
 * `upto` usage-based pattern:
 *
 *   GET  /session                      -> 402 upto terms (pricePerKwh, ceiling)
 *   POST /session/start  X-CHARGE-AUTH -> verify the agent's signed ceiling
 *                                          authorization (the VOUCHER), charge_start
 *   POST /session/stop   PAYMENT-SIGNATURE -> settle the metered actual, charge_stop
 *
 * The voucher (authorized ceiling, in-progress) becomes step0 and the finalized
 * on-chain settlement (actual, terminal) becomes step1 of the settlement-receipt
 * binding vector — amount stays OUT of the action join key, so the offered ceiling
 * and the settled actual join to the same lifecycle.
 */
import http from "node:http";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { Requirements, SignedPayment, buildPayment, encodeHeader, decodeHeader, short } from "./lib.js";
import { requirePor } from "./por-gate.js";

// ---- kWh metering math (integer-safe) ----
export const kwhForSocDelta = (socStart: number, socEnd: number, capacityKwh: number): number =>
  Math.max(0, ((socEnd - socStart) / 100) * capacityKwh);

/** atomic owed for `kwh` at `pricePerKwhAtomic`, capped at `ceilingAtomic`. */
export function amountForKwh(kwh: number, pricePerKwhAtomic: bigint, ceilingAtomic: bigint): bigint {
  const milliKwh = BigInt(Math.round(kwh * 1000));
  const raw = (pricePerKwhAtomic * milliKwh) / 1000n;
  return raw > ceilingAtomic ? ceilingAtomic : raw;
}

export type MeteredConfig = {
  facilitatorUrl: string;
  network: string;
  asset: string;
  decimals: number;
  pricePerKwhAtomic: string;
  authorizedCeiling: string; // atomic ceiling the session may bill up to
  payTo: string;
  vehicleUrl: string;
  vin: string;
  capacityKwh: number;
  chargeToPct: number;
  amps: number;
  stationId: string;
  porJwksUrl?: string; // if set, the station only charges a verified-human's agent (#2677)
  porMinLevel?: number;
};

type ChargeAuth = { authB64: string; sig: string; signer: string };
type PorInfo = { credId: string; level: number; subject: string };
type Session = { sessionId: string; socStart: number; scope: string; auth: ChargeAuth; authFields: any; por?: PorInfo };

async function vehicleCmd(base: string, vin: string, cmd: string, body?: unknown) {
  const r = await fetch(`${base}/api/1/vehicles/${vin}/command/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return (await r.json()) as { response?: { result?: boolean; reason?: string } };
}
async function vehicleSoc(base: string, vin: string): Promise<{ soc: number; state: string }> {
  const r: any = await (await fetch(`${base}/api/1/vehicles/${vin}/vehicle_data`)).json();
  const cs = r?.response?.charge_state ?? {};
  return { soc: Number(cs.battery_level ?? 0), state: String(cs.charging_state ?? "Unknown") };
}

// ---------------------------------------------------------------- charger ----
export async function startMeteredCharger(cfg: MeteredConfig): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Map<string, Session>();
  const scopeFor = (sid: string) =>
    `station:${cfg.stationId}/session:${sid}/upto:${cfg.authorizedCeiling}atomic`;

  const terms = () => ({
    scheme: "upto",
    network: cfg.network,
    asset: cfg.asset,
    decimals: cfg.decimals,
    pricePerKwhAtomic: cfg.pricePerKwhAtomic,
    authorizedCeiling: cfg.authorizedCeiling,
    payTo: cfg.payTo,
    stationId: cfg.stationId,
    capacityKwh: cfg.capacityKwh,
    chargeToPct: cfg.chargeToPct,
  });

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const send = (code: number, headers: Record<string, string>, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const url = (req.url ?? "").split("?")[0];

    // discover the upto terms
    if (req.method === "GET" && url === "/session") {
      const body = { x402Version: 2, error: "authorize a ceiling at POST /session/start", accepts: [terms()] };
      return send(402, { "PAYMENT-REQUIRED": encodeHeader(body) }, body);
    }

    // pre-authorize: verify the agent's signed ceiling voucher, then start charging
    if (req.method === "POST" && url === "/session/start") {
      const raw = req.headers["x-charge-auth"];
      if (typeof raw !== "string") return send(401, {}, { error: "X-CHARGE-AUTH required" });
      let auth: ChargeAuth;
      try {
        auth = decodeHeader<ChargeAuth>(raw);
      } catch {
        return send(400, {}, { error: "X-CHARGE-AUTH not base64 JSON" });
      }
      const msg = fromBase64(auth.authB64);
      const okSig = await new Ed25519PublicKey(fromBase64(auth.signer)).verifyPersonalMessage(msg, auth.sig);
      if (!okSig) return send(401, {}, { error: "voucher signature invalid" });
      const authFields = JSON.parse(new TextDecoder().decode(msg));
      if (BigInt(authFields.authorizedCeiling ?? 0) < BigInt(cfg.authorizedCeiling)) {
        return send(402, {}, { error: "authorized ceiling below station terms" });
      }

      // proof-of-personhood gate (#2677): only a verified-human's agent may charge
      let por: PorInfo | undefined;
      if (cfg.porJwksUrl) {
        const vc = req.headers["x-por-vc"];
        if (typeof vc !== "string") return send(403, {}, { error: "PoR credential required (X-POR-VC)" });
        try {
          por = await requirePor(vc, cfg.porJwksUrl, authFields.signerAddr, cfg.porMinLevel ?? 0);
        } catch (e: any) {
          return send(403, {}, { error: `personhood check failed: ${e?.message ?? e}` });
        }
      }

      const before = await vehicleSoc(cfg.vehicleUrl, cfg.vin);
      await vehicleCmd(cfg.vehicleUrl, cfg.vin, "set_charge_limit", { percent: cfg.chargeToPct });
      await vehicleCmd(cfg.vehicleUrl, cfg.vin, "set_charging_amps", { charging_amps: cfg.amps });
      const start = await vehicleCmd(cfg.vehicleUrl, cfg.vin, "charge_start");
      if (!start.response?.result) return send(409, {}, { error: `charge_start refused: ${start.response?.reason}` });

      const sessionId = `chg_${Date.now().toString(36)}`;
      const scope = scopeFor(sessionId);
      sessions.set(sessionId, { sessionId, socStart: before.soc, scope, auth, authFields, por });
      return send(200, {}, { sessionId, socStart: before.soc, scope, por: por ?? null });
    }

    // finalize: meter actual kWh, settle the exact actual on-chain, charge_stop
    if (req.method === "POST" && url === "/session/stop") {
      const body = await readBody(req);
      const sess = sessions.get(body.sessionId);
      if (!sess) return send(404, {}, { error: "unknown session" });
      const sig = req.headers["payment-signature"];
      if (typeof sig !== "string") return send(402, {}, { error: "PAYMENT-SIGNATURE required to settle" });

      const after = await vehicleSoc(cfg.vehicleUrl, cfg.vin);
      const kwh = kwhForSocDelta(sess.socStart, after.soc, cfg.capacityKwh);
      const actual = amountForKwh(kwh, BigInt(cfg.pricePerKwhAtomic), BigInt(cfg.authorizedCeiling));
      const uncharged = BigInt(cfg.authorizedCeiling) - actual;

      // settle the metered ACTUAL against our own terms (exact transfer of `actual`)
      const reqs: Requirements = {
        scheme: "exact",
        network: cfg.network,
        amount: actual.toString(),
        asset: cfg.asset,
        payTo: cfg.payTo,
        maxTimeoutSeconds: 60,
        extra: { kind: "ev-charge-metered", kwh: kwh.toFixed(3) },
      };
      let agentPayload: any;
      try {
        agentPayload = decodeHeader<any>(sig);
      } catch {
        return send(400, {}, { error: "PAYMENT-SIGNATURE not base64 JSON" });
      }
      const settleBody = {
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: reqs, payload: agentPayload.payload },
        paymentRequirements: reqs,
      };
      let settle: any;
      try {
        settle = await (
          await fetch(`${cfg.facilitatorUrl}/settle`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(settleBody),
          })
        ).json();
      } catch (e: any) {
        return send(502, {}, { error: `facilitator unreachable: ${e?.message ?? e}` });
      }
      if (!settle?.success) return send(402, {}, { error: settle?.errorReason ?? "settlement failed" });

      await vehicleCmd(cfg.vehicleUrl, cfg.vin, "charge_stop");
      sessions.delete(body.sessionId);

      const finalized = {
        sessionId: sess.sessionId,
        scope: sess.scope,
        agentId: sess.authFields.agentId,
        socStart: sess.socStart,
        socEnd: after.soc,
        kwh: kwh.toFixed(3),
        authorizedCeiling: cfg.authorizedCeiling,
        actual: actual.toString(),
        uncharged: uncharged.toString(),
        asset: cfg.asset,
        decimals: cfg.decimals,
        network: cfg.network,
        payTo: cfg.payTo,
        txDigest: settle.transaction,
        voucherSig: sess.auth.sig,
        voucherSigner: sess.authFields.signerAddr,
        timestampMs: Number(sess.authFields.ts),
        por: sess.por ?? null,
      };
      return send(200, { "PAYMENT-RESPONSE": encodeHeader(settle) }, finalized);
    }

    return send(404, {}, { error: "not found", path: url });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ----------------------------------------------------------------- agent -----
export type MeteredResult = { finalized: any; digest: string; requirementsAmount: string };

export async function runMeteredAgent(
  chargerUrl: string,
  vehicleUrl: string,
  vin: string,
  client: SuiJsonRpcClient,
  car: Ed25519Keypair,
  budgetAtomic: bigint,
  onStep: (msg: string) => void = () => {},
  porVc?: string,
): Promise<MeteredResult> {
  // 1. discover upto terms
  const terms: any = (await (await fetch(`${chargerUrl}/session`)).json()).accepts[0];
  const ceiling = BigInt(terms.authorizedCeiling);
  onStep(
    `402 upto terms — ${terms.pricePerKwhAtomic} atomic/kWh, ceiling ${terms.authorizedCeiling} to ${short(terms.payTo)}`,
  );
  if (ceiling > budgetAtomic) throw new Error(`ceiling ${ceiling} exceeds agent budget ${budgetAtomic} — declining`);

  // 2. sign the ceiling authorization (the VOUCHER) and start the session
  const ts = Date.now();
  const agentId = `agent:ev:${car.toSuiAddress().slice(0, 10)}`;
  const authObj = {
    agentId,
    authorizedCeiling: terms.authorizedCeiling,
    payTo: terms.payTo,
    signerAddr: car.toSuiAddress(),
    ts,
  };
  const authBytes = new TextEncoder().encode(JSON.stringify(authObj));
  const { signature } = await car.signPersonalMessage(authBytes);
  const auth = { authB64: toBase64(authBytes), sig: signature, signer: car.getPublicKey().toBase64() };
  onStep(`signed ceiling voucher (up to ${terms.authorizedCeiling}) from ${short(car.toSuiAddress())}`);

  const startHeaders: Record<string, string> = { "x-charge-auth": encodeHeader(auth) };
  if (porVc) {
    startHeaders["x-por-vc"] = porVc;
    onStep(`presenting PoR credential (verified-human)`);
  }
  const startRes = await fetch(`${chargerUrl}/session/start`, { method: "POST", headers: startHeaders });
  if (startRes.status !== 200) throw new Error(`start rejected (${startRes.status}): ${await startRes.text()}`);
  const session: any = await startRes.json();
  onStep(`session ${session.sessionId} started · SoC ${session.socStart}% · charging`);

  // 3. wait for the charge to complete, metering kWh from the SoC climb
  let socEnd = session.socStart;
  for (let i = 0; i < 60; i++) {
    const r = await vehicleSoc(vehicleUrl, vin);
    socEnd = r.soc;
    onStep(`metering — SoC ${r.soc}% (${r.state})`);
    if (r.state === "Complete" || r.state === "Stopped") break;
    await new Promise((res) => setTimeout(res, 700));
  }
  const kwh = kwhForSocDelta(session.socStart, socEnd, terms.capacityKwh);
  const actual = amountForKwh(kwh, BigInt(terms.pricePerKwhAtomic), ceiling);
  onStep(`metered ${kwh.toFixed(3)} kWh → actual ${actual} atomic (uncharged ${ceiling - actual})`);

  // 4. settle the metered ACTUAL on-chain, then stop
  const payload: SignedPayment = await buildPayment(client, car, terms.payTo, actual, terms.asset);
  const stopRes = await fetch(`${chargerUrl}/session/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": encodeHeader({ payload }) },
    body: JSON.stringify({ sessionId: session.sessionId }),
  });
  if (stopRes.status !== 200) throw new Error(`stop/settle rejected (${stopRes.status}): ${await stopRes.text()}`);
  const finalized: any = await stopRes.json();
  onStep(`settled actual on Sui (digest ${short(finalized.txDigest)}), charge_stop sent`);

  return { finalized, digest: finalized.txDigest, requirementsAmount: actual.toString() };
}
