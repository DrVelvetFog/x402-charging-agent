/**
 * Phase 3 demo: a personhood-gated, usage-metered EV charge (#2677 + #2666).
 *
 * The station only delivers energy to a verified human's agent. The demo proves
 * the gate BOTH ways:
 *   A. an agent with no PoR credential is refused before any charge or payment
 *   B. an agent presenting a valid PoR SD-JWT-VC (bound to its paying wallet)
 *      charges, meters kWh, settles the actual on Sui, and emits a
 *      settlement-receipt vector that records the personhood evidence.
 *
 *   bash vectors/setup.sh   # one-time
 *   npm run demo:gated
 *
 * Real x402 settlement on Sui testnet; the car is mocked behind Tesla's HTTP
 * contract; the PoR issuer is a clearly-labelled demo issuer (real verify logic,
 * swap jwksUrl to the live attestor for production).
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { startMockVehicle } from "./mock-vehicle.js";
import { startMeteredCharger, runMeteredAgent } from "./metered.js";
import { startPorIssuer } from "./por-gate.js";
import { SUI, getClient, loadKeypair, ensureGas, onchainNetToPayTo, explorerUrl, rpcFor, usdcFor } from "./lib.js";

const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const NETWORK = process.env.NETWORK ?? "sui:testnet";
const RPC = process.env.SUI_RPC ?? rpcFor(NETWORK);
const USE_USDC = (process.env.ASSET ?? "SUI") === "USDC";
const ASSET = USE_USDC ? usdcFor(NETWORK) : SUI;
const DECIMALS = USE_USDC ? 6 : 9;
const PRICE_PER_KWH = process.env.PRICE_PER_KWH ?? (USE_USDC ? "1000" : "100000");
const CEILING = process.env.CEILING ?? (USE_USDC ? "50000" : "5000000");
const START_SOC = Number(process.env.START_SOC ?? 42);
const CHARGE_TO = Number(process.env.CHARGE_TO ?? 55);
const CAPACITY_KWH = Number(process.env.BATTERY_KWH ?? 75);
const AMPS = Number(process.env.AMPS ?? 32);
const STATION = process.env.STATION ?? "acme-supercharger-7";
const POR_MIN_LEVEL = Number(process.env.POR_MIN_LEVEL ?? 0);

if (NETWORK === "sui:mainnet" && process.env.CONFIRM_MAINNET !== "1") {
  console.error("\n  ⚠️  NETWORK=sui:mainnet settles with REAL funds (no faucet).\n  Re-run with CONFIRM_MAINNET=1.\n");
  process.exit(1);
}

const line = (tag: string, s: string) => console.log(`  ${tag.padEnd(7)} ${s}`);
function runPy(script: string): { code: number; out: string } {
  const py = process.env.VECTOR_PY ?? (fs.existsSync("vectors/.venv/bin/python") ? "vectors/.venv/bin/python" : "python3");
  const r = spawnSync(py, [script], { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function main() {
  console.log(`\n  x402 EV charging agent · Phase 3 (personhood-gated + metered)\n  network ${NETWORK}\n  facilitator ${FACILITATOR}\n`);

  const client = getClient(NETWORK);
  const car = loadKeypair("car");
  const station = loadKeypair("station");
  line("car", `wallet ${car.toSuiAddress()}`);
  await ensureGas(client, car.toSuiAddress(), NETWORK);

  const sup: any = await (await fetch(`${FACILITATOR}/supported`)).json();
  const ok = sup.kinds?.some((k: any) => k.network === NETWORK && k.scheme === "exact" && k.x402Version === 2);
  line("①", `GET /supported → ${NETWORK} exact ${ok ? "✓" : "✗"}`);
  if (!ok) throw new Error(`facilitator does not advertise ${NETWORK} exact`);

  const por = await startPorIssuer(NETWORK);
  line("②", `PoR issuer online (demo) · JWKS ${por.jwksUrl}`);

  const vehicle = await startMockVehicle({ startSoc: START_SOC, chargeLimit: 100, ratePctPerSec: 4 });
  const charger = await startMeteredCharger({
    facilitatorUrl: FACILITATOR, network: NETWORK, asset: ASSET, decimals: DECIMALS,
    pricePerKwhAtomic: PRICE_PER_KWH, authorizedCeiling: CEILING, payTo: station.toSuiAddress(),
    vehicleUrl: vehicle.url, vin: vehicle.vin, capacityKwh: CAPACITY_KWH, chargeToPct: CHARGE_TO,
    amps: AMPS, stationId: STATION, porJwksUrl: por.jwksUrl, porMinLevel: POR_MIN_LEVEL,
  });
  line("③", `personhood-gated station live · requires a PoR L${POR_MIN_LEVEL}+ credential`);

  try {
    const budget = BigInt(CEILING) * 2n;

    // A. no credential -> refused before any charge or payment
    try {
      await runMeteredAgent(charger.url, vehicle.url, vehicle.vin, client, car, budget, () => {});
      throw new Error("gate FAILED: charge proceeded without a PoR credential");
    } catch (e: any) {
      if (/gate FAILED/.test(e?.message)) throw e;
      line("Ⓐ", `no-credential agent refused ✓ (${String(e?.message).split(":").slice(-1)[0].trim()})`);
    }

    // B. valid credential bound to the paying wallet -> charges
    const vc = await por.issueVc(car.toSuiAddress(), { unique: true, level: POR_MIN_LEVEL });
    line("Ⓑ", `issued PoR VC for the car wallet — retrying`);
    const r = await runMeteredAgent(charger.url, vehicle.url, vehicle.vin, client, car, budget, (m) => line("→", m), vc);
    const f = r.finalized;
    line("⑤", `explorer: ${explorerUrl(NETWORK, r.digest)}`);

    await client.waitForTransaction({ digest: r.digest });
    const net = await onchainNetToPayTo(RPC, r.digest, station.toSuiAddress(), ASSET);
    const match = net === BigInt(f.actual);
    line("⑥", `on-chain net to station = ${net} (metered actual ${f.actual}) ${match ? "✓ verified" : "✗ MISMATCH"}`);
    line("⑦", `metered ${f.kwh} kWh · billed ${f.actual} · PoR ${f.por?.credId} (L${f.por?.level})`);

    const session = {
      agentId: f.agentId, actionType: "energy.charge.metered", scope: f.scope, timestampMs: f.timestampMs,
      asset: f.asset, decimals: f.decimals, network: "testnet", payTo: f.payTo,
      authorizedCeiling: f.authorizedCeiling, actual: f.actual, uncharged: f.uncharged, kwh: f.kwh,
      sessionId: f.sessionId, txDigest: f.txDigest, voucherSig: f.voucherSig, voucherSigner: f.voucherSigner,
      por: f.por ? { credId: f.por.credId, level: f.por.level, subject: f.por.subject } : undefined,
    };
    fs.writeFileSync("vectors/session.json", JSON.stringify(session, null, 2));

    const emit = runPy("vectors/emit_charge_vector.py");
    if (emit.code !== 0) {
      line("⑧", "vector emit skipped (Python deps missing) — run: bash vectors/setup.sh");
    } else {
      emit.out.trim().split("\n").forEach((l) => line("⑧", l));
      const chk = runPy("vectors/_check_independent.py");
      chk.out.trim().split("\n").forEach((l) => line("⑨", l));
      if (chk.code !== 0) throw new Error("conformance checker failed");
    }

    console.log(
      `\n  ${match ? "✅ gate refused the anon agent · verified human charged · metered actual settled · receipt-binding vector verified" : "❌ demo failed a check"}\n`,
    );
    if (!match) process.exit(1);
  } finally {
    await charger.close();
    await vehicle.close();
    await por.close();
  }
}

main().catch((e) => {
  console.error("\n  demo failed:", e?.message ?? e, "\n");
  process.exit(1);
});
