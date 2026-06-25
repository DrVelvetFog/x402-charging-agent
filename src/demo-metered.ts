/**
 * Phase 2 demo: a metered EV charge billed over the x402 `upto` model, then
 * emitted as a settlement-receipt-binding conformance vector.
 *
 * Arc:
 *   discover upto terms -> agent signs a ceiling VOUCHER -> charge_start ->
 *   meter kWh -> settle the ACTUAL (<= ceiling) exact on Sui -> charge_stop ->
 *   on-chain recompute -> emit step0(voucher)/step1(finalized) vector ->
 *   independent checker (action_ref_recomputes, settlement_binding_resolves,
 *   receipt_signature_ok, lifecycle_distinguishes_terminal)
 *
 *   npm run demo:metered
 *   PRICE_PER_KWH=100000 CEILING=5000000 CHARGE_TO=55 START_SOC=42 ...
 *
 * Real x402 settlement on Sui testnet; the car is mocked behind Tesla's HTTP
 * command contract. The emitted vector passes the same checker as Tony's
 * #2666 / SVM-upto conformance set — EV charging as a usage-based reference.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { startMockVehicle } from "./mock-vehicle.js";
import { startMeteredCharger, runMeteredAgent } from "./metered.js";
import { SUI, getClient, loadKeypair, ensureGas, onchainNetToPayTo, explorerUrl, rpcFor, usdcFor } from "./lib.js";

const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const NETWORK = process.env.NETWORK ?? "sui:testnet";
const RPC = process.env.SUI_RPC ?? rpcFor(NETWORK);
const USE_USDC = (process.env.ASSET ?? "SUI") === "USDC";
const ASSET = USE_USDC ? usdcFor(NETWORK) : SUI;
const DECIMALS = USE_USDC ? 6 : 9;
const PRICE_PER_KWH = process.env.PRICE_PER_KWH ?? (USE_USDC ? "1000" : "100000"); // per kWh, atomic
const CEILING = process.env.CEILING ?? (USE_USDC ? "50000" : "5000000"); // atomic upto ceiling
const START_SOC = Number(process.env.START_SOC ?? 42);
const CHARGE_TO = Number(process.env.CHARGE_TO ?? 55);
const CAPACITY_KWH = Number(process.env.BATTERY_KWH ?? 75);
const AMPS = Number(process.env.AMPS ?? 32);
const STATION = process.env.STATION ?? "acme-supercharger-7";

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
  console.log(`\n  x402 EV charging agent · Phase 2 (metered / upto)\n  network ${NETWORK}\n  facilitator ${FACILITATOR}\n`);

  const client = getClient(NETWORK);
  const car = loadKeypair("car");
  const station = loadKeypair("station");
  line("car", `wallet ${car.toSuiAddress()}`);
  await ensureGas(client, car.toSuiAddress(), NETWORK);

  const sup: any = await (await fetch(`${FACILITATOR}/supported`)).json();
  const ok = sup.kinds?.some((k: any) => k.network === NETWORK && k.scheme === "exact" && k.x402Version === 2);
  line("①", `GET /supported → ${NETWORK} exact (used to finalize the metered actual) ${ok ? "✓" : "✗"}`);
  if (!ok) throw new Error(`facilitator does not advertise ${NETWORK} exact`);

  const vehicle = await startMockVehicle({ startSoc: START_SOC, chargeLimit: 100, ratePctPerSec: 4 });
  line("②", `vehicle online ${vehicle.vin} · SoC ${START_SOC}% · pack ${CAPACITY_KWH} kWh`);

  const charger = await startMeteredCharger({
    facilitatorUrl: FACILITATOR,
    network: NETWORK,
    asset: ASSET,
    decimals: DECIMALS,
    pricePerKwhAtomic: PRICE_PER_KWH,
    authorizedCeiling: CEILING,
    payTo: station.toSuiAddress(),
    vehicleUrl: vehicle.url,
    vin: vehicle.vin,
    capacityKwh: CAPACITY_KWH,
    chargeToPct: CHARGE_TO,
    amps: AMPS,
    stationId: STATION,
  });
  line("③", `metered station live · ${PRICE_PER_KWH} atomic/kWh · ceiling ${CEILING} · to ${CHARGE_TO}%`);

  try {
    const budget = BigInt(CEILING) * 2n;
    const r = await runMeteredAgent(charger.url, vehicle.url, vehicle.vin, client, car, budget, (m) => line("→", m));
    const f = r.finalized;
    line("⑤", `explorer: ${explorerUrl(NETWORK, r.digest)}`);

    await client.waitForTransaction({ digest: r.digest });
    const net = await onchainNetToPayTo(RPC, r.digest, station.toSuiAddress(), ASSET);
    const match = net === BigInt(f.actual);
    line("⑥", `on-chain net to station = ${net} (metered actual ${f.actual}) ${match ? "✓ verified" : "✗ MISMATCH"}`);

    // hand the REAL session to the vector emitter
    const session = {
      agentId: f.agentId,
      actionType: "energy.charge.metered",
      scope: f.scope,
      timestampMs: f.timestampMs,
      asset: f.asset,
      decimals: f.decimals,
      network: "testnet",
      payTo: f.payTo,
      authorizedCeiling: f.authorizedCeiling,
      actual: f.actual,
      uncharged: f.uncharged,
      kwh: f.kwh,
      sessionId: f.sessionId,
      txDigest: f.txDigest,
      voucherSig: f.voucherSig,
      voucherSigner: f.voucherSigner,
    };
    fs.writeFileSync("vectors/session.json", JSON.stringify(session, null, 2));
    line("⑦", `metered ${f.kwh} kWh · billed ${f.actual} · unused ceiling ${f.uncharged}`);

    // emit the settlement-receipt vector and run the independent checker
    const emit = runPy("vectors/emit_charge_vector.py");
    if (emit.code !== 0) {
      line("⑧", "vector emit skipped (Python deps missing) — run: bash vectors/setup.sh");
      console.log(emit.out.trim().split("\n").map((l) => `          ${l}`).join("\n"));
    } else {
      emit.out.trim().split("\n").forEach((l) => line("⑧", l));
      const chk = runPy("vectors/_check_independent.py");
      chk.out.trim().split("\n").forEach((l) => line("⑨", l));
      if (chk.code !== 0) throw new Error("conformance checker failed");
    }

    console.log(
      `\n  ${match ? "✅ car authorized a ceiling · metered actual settled on Sui · receipt-binding vector verified" : "❌ demo failed a check"}\n`,
    );
    if (!match) process.exit(1);
  } finally {
    await charger.close();
    await vehicle.close();
  }
}

main().catch((e) => {
  console.error("\n  demo failed:", e?.message ?? e, "\n");
  process.exit(1);
});
