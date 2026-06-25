# Walkthrough — x402 EV Charging Agent

A study/explainer asset for the project: what it is, why it matters, and how to
talk about it in a grant call or interview. The goal here is to be able to
*explain* the system, not just run it.

## One sentence

An electric vehicle autonomously pays for its own charge — proving its owner is a
real human (Proof of Real), authorizing a spending ceiling, drawing metered
energy, and settling the exact amount used on Sui — and the whole session emits a
cryptographic receipt that a third party can independently verify.

## Why it matters (the money path)

This is **machine-to-machine commerce with a physical payload** — the canonical
x402 agent-economy story, made concrete with real hardware (Tesla's vehicle API)
and a real settlement rail (a non-custodial Sui facilitator). It's three things at
once:

1. A **flashy, legible demo** — "the car paid for itself" — for grants/portfolio.
2. A **second-rail reference implementation** of the x402 `upto` usage-based
   scheme + the [#2666 settlement-receipt binding](https://github.com/x402-foundation/x402/pull/2666),
   with EV charging as the textbook metered case (complements the Solana `upto` work).
3. A live composition of **#2677 personhood-gated payments** (`scheme:"por"`) — a
   real human's agent, not a bot, transacting.

## The three phases

| Phase | Command | What it proves |
|-------|---------|----------------|
| 1 — fixed price | `npm run demo` | the end-to-end loop: 402 → pay → settle on Sui → `charge_start` → battery fills → on-chain recompute |
| 2 — metered `upto` | `npm run demo:metered` | authorize a ceiling → meter kWh → settle the **actual** (≤ ceiling) → emit a settlement-receipt vector that passes the independent checker |
| 3 — personhood-gated | `npm run demo:gated` | only a **verified human's** agent charges; the anon agent is refused; PoR evidence is bound into the receipt |

## How the pieces fit

```
PoR issuer ──issues SD-JWT-VC──► car-agent ──┐
(demo; real attestor in prod)                │ X-POR-VC + signed ceiling voucher
                                             ▼
                                       charging station (x402 + PoR gate)
                                             │  1. verify personhood (bound to payer)
                                             │  2. charge_start ─────► vehicle (Tesla
                                             │  3. meter kWh                HTTP contract;
                                             │  4. settle ACTUAL ──► Sui facilitator   mock now)
                                             │  5. charge_stop
                                             ▼
                              step0 voucher + step1 finalized  ──►  independent checker
                              (settlement-receipt binding vector)    (7 verdicts, all OK)
```

## The one idea that makes it a standard, not a demo

**Amount stays out of the action join key.** The `actionRef` that ties a receipt to
a session is `sha256(JCS({agentId, actionType, scope, timestampMs, seq, terminal}))`
— it deliberately excludes the amount. So the *offered ceiling* (step0) and the
*settled actual* (step1) join to the same lifecycle, and a mid-session voucher
can't be passed off as the final receipt (`terminal: false` vs `true`). That's the
#2666 thesis — *bind the finalized result, not the voucher* — and metered EV
charging is the cleanest real-world example of it.

## What's real vs. demo (honest labeling)

| Real | Demo / mocked |
|------|----------------|
| x402 payment + settlement on **Sui testnet** (live facilitator) | the **vehicle** — mocked behind Tesla's real `tesla-http-proxy` HTTP contract |
| on-chain recompute of net-balance-change to the station | the **PoR issuer** — a throwaway Ed25519 issuer (real `verifyPorVc` logic) |
| the conformance **checker** — vendored verbatim from `vaaraio/vaara` v1.1.1 | the receipt **issuer key** — throwaway ES256 (real issuer signs in prod) |
| the agent's ceiling **voucher** — a real Ed25519 signature | |

Each mock swaps to production without touching the payment loop: point the vehicle
base URL at a real `tesla-http-proxy` + car; point `jwksUrl` at the real PoR
attestor (or gate on-chain with `por-sdk`'s `PorClient.isVerified`).

## How to explain it (Q&A)

**Q: Why x402 and not a card?** Cards can't be held by software autonomously, settle
in days, and aren't programmable per-call. x402 lets an agent pay per action,
settle in seconds, non-custodially, and carry a verifiable receipt.

**Q: Why is the amount kept out of the join key?** Because usage isn't known until
the work is done. You authorize a ceiling, deliver, then settle the actual. If the
join key included the amount, the authorization and the settlement wouldn't link.

**Q: What stops a bot from draining a charger?** The personhood gate: the station
verifies a PoR credential *bound to the paying wallet* before delivering energy. No
credential, no charge — proven in the demo.

**Q: What's actually on-chain?** A real Sui transfer of the metered amount to the
station, which the demo independently recomputes from the transaction's balance
changes — it never trusts the operator's word for it.

**Q: How would this run on a real car?** The mock vehicle speaks Tesla's exact
command contract (`/api/1/vehicles/{vin}/command/charge_start`, …). Swapping in
`tesla-http-proxy` + an enrolled virtual key is a base-URL change.
