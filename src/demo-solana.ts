/**
 * Solana devnet proof: meter via OCPI, settle the CDR's actual on Solana.
 *
 * The pilot shape on the DePIN networks' own chain — a real Solana devnet
 * settlement, independently recomputed. De-risks a DeCharge/Starpower pilot
 * (they're Solana) and produces a real on-chain Solana run, not a fixture.
 *
 *   npm run demo:solana
 *
 * SOL on devnet (airdrop-funded) for a free turnkey proof; production settles
 * USDC via an x402 SVM facilitator. The OCPI metering + CDR are the same as the
 * Sui bridge — only the settlement rail changes.
 */
import { startOcpiCpo } from "./ocpi-cpo.js";
import { amountForKwh } from "./metered.js";
import { conn, loadSolanaKeypair, ensureSol, settleSol, recomputeSolToPayee, solExplorer, SOLANA_RPC } from "./solana-settle.js";

const PRICE_PER_KWH = BigInt(process.env.PRICE_PER_KWH ?? "100000"); // lamports/kWh
const CEILING = BigInt(process.env.CEILING ?? "5000000"); // lamports
const TARGET_KWH = Number(process.env.TARGET_KWH ?? 10);

const line = (tag: string, s: string) => console.log(`  ${tag.padEnd(7)} ${s}`);
const ocpiGet = async (base: string, p: string) => (await (await fetch(`${base}${p}`)).json())?.data;
const ocpiPost = async (base: string, p: string, b: unknown) =>
  (await (await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json())?.data;

async function main() {
  console.log(`\n  x402 EV charging agent · Solana devnet settle\n  rpc ${SOLANA_RPC}\n`);

  const c = conn();
  const car = loadSolanaKeypair("solana-car");
  const station = loadSolanaKeypair("solana-station");
  line("car", `solana wallet ${car.publicKey.toBase58()}`);
  line("→", "requesting devnet airdrop…");
  await ensureSol(c, car.publicKey);
  line("①", `car funded (${(await c.getBalance(car.publicKey)) / 1e9} SOL)`);

  // OCPI charging network meters the energy (same CDR source as the Sui bridge)
  const cpo = await startOcpiCpo({ targetKwh: TARGET_KWH, ratePerSec: 3 });
  line("②", `OCPI network online · CPO ${cpo.cpo} · target ${TARGET_KWH} kWh`);
  const start = await ocpiPost(cpo.url, "/ocpi/2.2/commands/START_SESSION", {
    response_url: "x402://noop", token: { uid: "x402-bridge", type: "AD_HOC_USER" }, location_id: "LOC-1", evse_uid: "EVSE-1",
  });
  line("③", `OCPI START_SESSION → ${start.result} (${start.session_id})`);

  try {
    let cdrReady = false, kwh = 0;
    for (let i = 0; i < 60 && !cdrReady; i++) {
      const s = await ocpiGet(cpo.url, `/ocpi/2.2/sessions/${start.session_id}`);
      kwh = Number(s?.kwh ?? 0);
      line("→", `metering (OCPI) — ${kwh} kWh (${s?.status})`);
      cdrReady = s?.status === "COMPLETED";
      if (!cdrReady) await new Promise((r) => setTimeout(r, 700));
    }
    const cdr = await ocpiGet(cpo.url, `/ocpi/2.2/cdrs/${start.session_id}`);
    const cdrKwh = Number(cdr.total_energy);
    const actual = amountForKwh(cdrKwh, PRICE_PER_KWH, CEILING);
    line("④", `CDR ${cdr.id} · ${cdrKwh} kWh → actual ${actual} lamports (uncharged ${CEILING - actual})`);

    // settle the CDR's actual on Solana devnet — a real on-chain transaction
    const sig = await settleSol(c, car, station.publicKey, actual);
    line("⑤", `settled on Solana devnet · ${solExplorer(sig)}`);

    // independent recompute from the tx's own balance deltas
    const net = await recomputeSolToPayee(c, sig, station.publicKey);
    const match = net === actual;
    line("⑥", `on-chain net to station = ${net} (CDR actual ${actual}) ${match ? "✓ verified" : "✗ MISMATCH"}`);

    console.log(`\n  ${match ? "✅ OCPI-metered · settled on Solana devnet · recompute matched (real tx)" : "❌ demo failed a check"}\n`);
    if (!match) process.exit(1);
  } finally {
    await cpo.close();
  }
}

main().catch((e) => { console.error("\n  demo failed:", e?.message ?? e, "\n"); process.exit(1); });
