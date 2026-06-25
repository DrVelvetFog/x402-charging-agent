/**
 * Bridge demo: an x402 charge settled against a real charging network's OCPI CDR.
 *
 * This is the charger side wired to a network (mocked here as a spec-faithful
 * OCPI CPO). Arc:
 *   discover upto terms -> agent signs ceiling voucher -> bridge OCPI START_SESSION
 *   -> network meters -> CDR (signed meter data) -> settle the CDR's actual on Sui
 *   -> on-chain recompute -> emit a settlement-receipt vector binding the CDR
 *
 *   bash vectors/setup.sh   # one-time
 *   npm run demo:ocpi
 *
 * Real x402 settlement on Sui testnet; the charging network is a mock OCPI CPO.
 * Swapping it for DeCharge/Starpower/PowerPod = base URL + OCPI credentials.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { startOcpiCpo } from "./ocpi-cpo.js";
import { startOcpiCharger, runOcpiAgent } from "./ocpi-bridge.js";
import { SUI, getClient, loadKeypair, ensureGas, onchainNetToPayTo, explorerUrl, rpcFor, usdcFor } from "./lib.js";

const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const NETWORK = process.env.NETWORK ?? "sui:testnet";
const RPC = process.env.SUI_RPC ?? rpcFor(NETWORK);
const USE_USDC = (process.env.ASSET ?? "SUI") === "USDC";
const ASSET = USE_USDC ? usdcFor(NETWORK) : SUI;
const DECIMALS = USE_USDC ? 6 : 9;
const PRICE_PER_KWH = process.env.PRICE_PER_KWH ?? (USE_USDC ? "1000" : "100000");
const CEILING = process.env.CEILING ?? (USE_USDC ? "50000" : "5000000");
const TARGET_KWH = Number(process.env.TARGET_KWH ?? 10);

if (NETWORK === "sui:mainnet" && process.env.CONFIRM_MAINNET !== "1") {
  console.error("\n  ⚠️  NETWORK=sui:mainnet settles with REAL funds.\n  Re-run with CONFIRM_MAINNET=1.\n");
  process.exit(1);
}

const line = (tag: string, s: string) => console.log(`  ${tag.padEnd(7)} ${s}`);
function runPy(script: string): { code: number; out: string } {
  const py = process.env.VECTOR_PY ?? (fs.existsSync("vectors/.venv/bin/python") ? "vectors/.venv/bin/python" : "python3");
  const r = spawnSync(py, [script], { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function main() {
  console.log(`\n  x402 EV charging agent · x402 ↔ OCPI bridge\n  network ${NETWORK}\n  facilitator ${FACILITATOR}\n`);

  const client = getClient(NETWORK);
  const car = loadKeypair("car");
  const station = loadKeypair("station");
  line("car", `wallet ${car.toSuiAddress()}`);
  await ensureGas(client, car.toSuiAddress(), NETWORK);

  const sup: any = await (await fetch(`${FACILITATOR}/supported`)).json();
  const ok = sup.kinds?.some((k: any) => k.network === NETWORK && k.scheme === "exact" && k.x402Version === 2);
  line("①", `GET /supported → ${NETWORK} exact ${ok ? "✓" : "✗"}`);
  if (!ok) throw new Error(`facilitator does not advertise ${NETWORK} exact`);

  const cpo = await startOcpiCpo({ targetKwh: TARGET_KWH, ratePerSec: 3 });
  line("②", `OCPI charging network online · CPO ${cpo.cpo} · target ${TARGET_KWH} kWh`);

  const charger = await startOcpiCharger({
    facilitatorUrl: FACILITATOR, network: NETWORK, asset: ASSET, decimals: DECIMALS,
    pricePerKwhAtomic: PRICE_PER_KWH, authorizedCeiling: CEILING, payTo: station.toSuiAddress(),
    cpoUrl: cpo.url, cpoId: cpo.cpo, locationId: "LOC-SF-01", evseUid: "EVSE-1",
  });
  line("③", `x402↔OCPI bridge live · ${PRICE_PER_KWH} atomic/kWh · ceiling ${CEILING}`);

  try {
    const budget = BigInt(CEILING) * 2n;
    const r = await runOcpiAgent(charger.url, client, car, budget, (m) => line("→", m));
    const f = r.finalized;
    line("⑤", `explorer: ${explorerUrl(NETWORK, r.digest)}`);

    await client.waitForTransaction({ digest: r.digest });
    const net = await onchainNetToPayTo(RPC, r.digest, station.toSuiAddress(), ASSET);
    const match = net === BigInt(f.actual);
    line("⑥", `on-chain net to station = ${net} (CDR actual ${f.actual}) ${match ? "✓ verified" : "✗ MISMATCH"}`);
    line("⑦", `CDR ${f.cdr.cdrId} · ${f.cdr.totalEnergyKwh} kWh · signed_data ${f.cdr.signedDataDigest.slice(0, 20)}…`);

    const session = {
      agentId: f.agentId, actionType: "energy.charge.ocpi", scope: f.scope, timestampMs: f.timestampMs,
      asset: f.asset, decimals: f.decimals, network: "testnet", payTo: f.payTo,
      authorizedCeiling: f.authorizedCeiling, actual: f.actual, uncharged: f.uncharged, kwh: f.kwh,
      sessionId: f.sessionId, txDigest: f.txDigest, voucherSig: f.voucherSig, voucherSigner: f.voucherSigner,
      cdr: f.cdr,
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

    console.log(`\n  ${match ? "✅ network metered (OCPI CDR) · CDR actual settled on Sui · CDR-bound receipt verified" : "❌ demo failed a check"}\n`);
    if (!match) process.exit(1);
  } finally {
    await charger.close();
    await cpo.close();
  }
}

main().catch((e) => { console.error("\n  demo failed:", e?.message ?? e, "\n"); process.exit(1); });
