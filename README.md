# x402 EV Charging Agent

An electric vehicle that **pays for its own charge** — autonomously, with no human
in the loop. The car's agent buys energy over [x402](https://github.com/x402-foundation/x402),
settled non-custodially on **Sui**, and the charging station only delivers power
once the payment clears on-chain.

This is machine-to-machine commerce with a physical payload: a real payment rail
authorizing a real-world action.

```
┌────────────┐  GET /session                    ┌─────────────────┐
│ car-agent  │ ───────────────────────────────▶ │  charger        │
│ (x402      │ ◀─── 402 Payment Required ─────── │  (x402 resource │
│  client +  │      {sui:testnet, amount, payTo} │   = energy      │
│  budget)   │ ─── retry w/ PAYMENT-SIGNATURE ─▶ │   seller)       │
└────────────┘                                   └────────┬────────┘
       ▲                                                  │ settle
       │ poll vehicle_data (SoC climbs)                   ▼
       │                              x402 facilitator (live Sui testnet)
       │                              → settlement digest + on-chain recompute
       │                                                  │ on success
       │                                                  ▼
       │                       POST /api/1/vehicles/{vin}/command/charge_start
       │                                                  ▼
       └──────────────────────────────────────  mock-vehicle
                                                  (Tesla command contract;
                                                   swap for a real car)
```

## Run it

```bash
npm install
npm run demo
```

Turnkey: settles **0.001 SUI** on testnet through the live facilitator, mocks the
car, and prints the full arc — `402 → approve → sign → settle → charge_start →
battery fills → complete → on-chain recompute`. A fresh wallet auto-faucets gas;
drop a funded key at `.secrets/car.key` to skip the faucet.

```bash
ASSET=USDC npm run demo          # pay in testnet USDC instead of SUI
AMOUNT=2000000 npm run demo      # session price (atomic units)
CHARGE_TO=80 START_SOC=42 npm run demo
FACILITATOR_URL=... NETWORK=...  # point at another facilitator / network
```

### Phase 2 — usage metering (`upto`) + settlement-receipt binding

```bash
bash vectors/setup.sh            # one-time: Python toolchain (rfc8785 + cryptography)
npm run demo:metered
```

Bills the charge over the x402 **`upto`** model — the agent signs a ceiling
*voucher*, the station meters kWh, then settles the **actual** amount (≤ ceiling)
exact on Sui. It then emits a settlement-receipt-binding vector
(`step0` = authorized-ceiling voucher, `step1` = finalized on-chain settlement)
and runs an **independent checker**:

```
metered 9.750 kWh → actual 975000 atomic (uncharged 4025000)
settled actual on Sui (digest 3kNGobFT…), charge_stop sent
on-chain net to station = 975000 (metered actual 975000) ✓ verified
[OK] sui.step0.action_ref_recomputes / settlement_binding_resolves / receipt_signature_ok
[OK] sui.step1.action_ref_recomputes / settlement_binding_resolves / receipt_signature_ok
[OK] sui.lifecycle_distinguishes_terminal
```

The amount stays **out of the action join key**, so the offered ceiling and the
settled actual bind to the same lifecycle — this is the [#2666 settlement-receipt
binding](https://github.com/x402-foundation/x402/pull/2666) with EV charging as
the usage-based case. The checker is vendored verbatim from the pinned
`vaaraio/vaara` conformance set (only the rail name differs), so a pass here means
the same thing it does upstream.

```bash
PRICE_PER_KWH=100000 CEILING=5000000 CHARGE_TO=55 npm run demo:metered
ASSET=USDC npm run demo:metered   # meter and settle in testnet USDC
```

### Phase 3 — proof-of-personhood gate (only a verified human charges)

```bash
npm run demo:gated
```

The station requires a **PoR credential bound to the paying wallet** before it
delivers energy (the [#2677](https://github.com/x402-foundation/x402/issues/2677)
`scheme:"por"` pattern). The demo proves the gate **both ways** — an agent with no
credential is refused before any charge or payment; an agent presenting a valid PoR
SD-JWT-VC charges, settles, and the personhood evidence is **bound into the receipt**:

```
Ⓐ no-credential agent refused ✓ (PoR credential required)
Ⓑ issued PoR VC for the car wallet — retrying
  metered 9.750 kWh · billed 975000 · PoR por:demo:0x614a0c94 (L0)
  [OK] sui.step1.settlement_binding_resolves  (settlement.por bound in the receipt)
```

`verifyPorVc` is vendored from [`por-sdk`](https://github.com/DrVelvetFog/por-sdk);
the issuer is a clearly-labelled demo issuer (real verify logic). Production = point
`jwksUrl` at the real PoR attestor's JWKS, or gate on-chain with `PorClient.isVerified`.

See [WALKTHROUGH.md](WALKTHROUGH.md) for the full explainer (architecture, the
standards tie-in, what's real vs mocked, and a Q&A).

## How it maps to real hardware

The `mock-vehicle` speaks the **same HTTP contract as Tesla's
[`tesla-http-proxy`](https://github.com/teslamotors/vehicle-command)** — the same
`POST /api/1/vehicles/{vin}/command/charge_start`, `set_charging_amps`,
`set_charge_limit`, and `GET .../vehicle_data` that a real car answers. Going
live (Phase 4) is a base-URL swap to a running `tesla-http-proxy` plus a Tesla
developer app and an enrolled virtual key — **no change to the payment loop.**

## Components

| File | Role |
|------|------|
| `src/car-agent.ts` | x402 client + spend policy; pays, then waits for the battery to fill |
| `src/charger.ts` | x402-gated station; on settled payment, commands the car to charge |
| `src/mock-vehicle.ts` | Tesla command contract + deterministic state-of-charge ramp |
| `src/demo.ts` | Phase 1 orchestrator (fixed price) |
| `src/metered.ts` | Phase 2 `upto` station + agent + kWh metering math |
| `src/demo-metered.ts` | Phase 2 orchestrator (meter → settle actual → emit + check vector) |
| `src/por-gate.ts` | Phase 3 personhood gate + demo PoR issuer (`verifyPorVc` vendored from por-sdk) |
| `src/demo-gated.ts` | Phase 3 orchestrator (refuse anon → verify human → metered settle) |
| `vectors/` | Python emitter + vendored conformance checker (settlement-receipt binding) |
| `src/lib.ts` | x402-on-Sui primitives, vendored from `x402-sui-stack` |

## Status & roadmap

- **Phase 1 — done:** fixed-price single charge, real Sui-testnet settlement,
  mocked vehicle. Proven end-to-end (`npm run demo`).
- **Phase 2 — done:** usage metering over `upto` — meter kWh, settle the *actual*
  amount (≤ ceiling) exact on Sui, and emit a settlement-receipt-binding vector
  (step0 voucher / step1 finalized) that passes the independent checker
  (`npm run demo:metered`). EV charging as the usage-based reference for #2666.
- **Phase 3 — done:** proof-of-personhood gate (only a verified human's agent may
  charge, bound to the payer), PoR evidence bound into the receipt, plus
  [WALKTHROUGH.md](WALKTHROUGH.md) (`npm run demo:gated`).
- **Phase 4 — next:** swap the mock for `tesla-http-proxy` + a real car; optionally
  point the PoR gate at the live attestor and record a demo video.

## Notes

Non-custodial throughout (the car holds its own keys; the facilitator never
custodies funds). Testnet by default — `NETWORK=sui:mainnet` requires
`CONFIRM_MAINNET=1`. The full gated + metered flow has also been run on **Sui
mainnet** with real funds (settlement ~0.001 SUI, i.e. a fraction of a cent),
not just testnet. The vendored `lib.ts` follows `x402-sui-stack`'s own
invitation to copy its seller/payment helpers. Tesla's `vehicle-command` is an
independent open-source project; this repo only targets its public HTTP contract
and is not affiliated with Tesla.
