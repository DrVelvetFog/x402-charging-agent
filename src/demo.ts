/**
 * Phase 1 demo: an EV agent buys its own charge.
 *
 * One command prints the whole arc as it happens:
 *   pull up -> 402 -> agent approves -> sign -> settle on Sui -> charge_start
 *   -> battery fills -> complete -> on-chain recompute verifies the payment
 *
 *   npm run demo                # SUI asset, auto-faucets gas — fully turnkey
 *   ASSET=USDC npm run demo     # needs testnet USDC at the printed car-wallet addr
 *   FACILITATOR_URL=...         # default https://sui-facilitator.onrender.com
 *   AMOUNT=...                  # session price, atomic units (default 0.001 SUI / $0.01 USDC)
 *   CHARGE_TO=55 START_SOC=42   # SoC ramp window
 *
 * Real x402 settlement on Sui testnet; the vehicle is mocked behind Tesla's own
 * HTTP command contract, so a real car is a Phase-4 base-URL swap.
 */
import { startMockVehicle } from "./mock-vehicle.js";
import { startCharger } from "./charger.js";
import { buyCharge, waitForCharge } from "./car-agent.js";
import { SUI, getClient, loadKeypair, ensureGas, onchainNetToPayTo, explorerUrl, rpcFor, usdcFor } from "./lib.js";

const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const NETWORK = process.env.NETWORK ?? "sui:testnet";
const RPC = process.env.SUI_RPC ?? rpcFor(NETWORK);
const USE_USDC = (process.env.ASSET ?? "SUI") === "USDC";
const ASSET = USE_USDC ? usdcFor(NETWORK) : SUI;
const AMOUNT = process.env.AMOUNT ?? (USE_USDC ? "10000" : "1000000"); // $0.01 USDC | 0.001 SUI
const START_SOC = Number(process.env.START_SOC ?? 42);
const CHARGE_TO = Number(process.env.CHARGE_TO ?? 55);
const KWH = Number(process.env.KWH ?? 10);
const AMPS = Number(process.env.AMPS ?? 32);

// mainnet settles with REAL funds — require an explicit opt-in
if (NETWORK === "sui:mainnet" && process.env.CONFIRM_MAINNET !== "1") {
  console.error("\n  ⚠️  NETWORK=sui:mainnet settles with REAL funds (no faucet).\n  Re-run with CONFIRM_MAINNET=1 to proceed.\n");
  process.exit(1);
}

const line = (tag: string, s: string) => console.log(`  ${tag.padEnd(7)} ${s}`);

async function main() {
  console.log(`\n  x402 EV charging agent · Phase 1\n  network ${NETWORK}\n  facilitator ${FACILITATOR}\n`);

  const client = getClient(NETWORK);
  const car = loadKeypair("car"); // the vehicle's wallet (payer)
  const station = loadKeypair("station"); // the charging-station operator (payTo)

  line("car", `wallet ${car.toSuiAddress()}`);
  await ensureGas(client, car.toSuiAddress(), NETWORK);

  // facilitator capability discovery
  const sup: any = await (await fetch(`${FACILITATOR}/supported`)).json();
  const ok = sup.kinds?.some((k: any) => k.network === NETWORK && k.scheme === "exact" && k.x402Version === 2);
  line("①", `GET /supported → advertises ${NETWORK} exact ${ok ? "✓" : "✗"}`);
  if (!ok) throw new Error(`facilitator does not advertise ${NETWORK} exact`);

  // the car (mocked behind Tesla's command contract)
  const vehicle = await startMockVehicle({ startSoc: START_SOC, chargeLimit: 100, ratePctPerSec: 4 });
  line("②", `vehicle online ${vehicle.vin} · SoC ${START_SOC}% (Tesla command contract @ ${vehicle.url})`);

  // the x402-gated charging station
  const charger = await startCharger({
    facilitatorUrl: FACILITATOR,
    network: NETWORK,
    asset: ASSET,
    amount: AMOUNT,
    payTo: station.toSuiAddress(),
    vehicleUrl: vehicle.url,
    vin: vehicle.vin,
    chargeToPct: CHARGE_TO,
    amps: AMPS,
    kwh: KWH,
  });
  line("③", `charging station live (x402-gated) · ${KWH} kWh to ${CHARGE_TO}% for ${AMOUNT} atomic`);

  try {
    // the car buys its own charge (budget = 5x the price, so it approves)
    const budget = BigInt(AMOUNT) * 5n;
    const r = await buyCharge(charger.url, client, car, budget, (m) => line("→", m));
    line("⑤", `explorer: ${explorerUrl(NETWORK, r.digest)}`);

    // watch the battery fill
    const done = await waitForCharge(vehicle.url, vehicle.vin, (soc, state) => line("⚡", `SoC ${soc}% (${state})`));
    line("⑥", `charge ${done.state} at ${done.soc}%`);

    // independent on-chain recompute (same check as the conformance MCP)
    await client.waitForTransaction({ digest: r.digest });
    const net = await onchainNetToPayTo(RPC, r.digest, station.toSuiAddress(), ASSET);
    const match = net === BigInt(r.requirements.amount);
    line("⑦", `on-chain net to station = ${net} (price ${r.requirements.amount}) ${match ? "✓ verified" : "✗ MISMATCH"}`);

    console.log(`\n  session: ${JSON.stringify(r.session)}`);
    console.log(
      `\n  ${match && done.state === "Complete" ? "✅ car paid · Sui settled · charge delivered · recompute matched" : "❌ demo failed a check"}\n`,
    );
    if (!match || done.state !== "Complete") process.exit(1);
  } finally {
    await charger.close();
    await vehicle.close();
  }
}

main().catch((e) => {
  console.error("\n  demo failed:", e?.message ?? e, "\n");
  process.exit(1);
});
