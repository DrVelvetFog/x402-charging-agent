#!/usr/bin/env python3
"""Emit a settlement-receipt-binding vector for a *metered EV charge*, in the
exact shape of the pinned vaaraio/vaara v1.1.1 conformance set
(tests/vectors/x402_settlement_v0) and Tony's SVM `upto` vector.

Driven by vectors/session.json, which the TS demo writes from a REAL Sui-testnet
metered charging session. It binds:

  step0  the authorized-ceiling VOUCHER (in-progress, terminal=false): the agent's
         signed ceiling authorization the station accepted before delivering energy.
  step1  the FINALIZED settlement (terminal=true): the actual metered amount,
         settled exact on-chain (real Sui tx digest), with the unused ceiling.

Both verdicts a third party can confirm with only settlement + receipt in hand:
  action_ref_recomputes        sha256(JCS({agentId,actionType,scope,timestampMs,
                               seq,terminal})) == settlement.actionRef. Amount and
                               ceiling are NOT in the tuple, so the offered ceiling
                               (step0) and the settled actual (step1) join.
  settlement_binding_resolves  sha256(JCS(settlement)) == receipt.evidenceRef.digest.
  lifecycle_distinguishes_terminal  step0/step1 have distinct action_refs and the
                               in-progress receipt can't be passed off as terminal.

The receipt signature uses a THROWAWAY demo ES256 key (keys/es256_public.pem),
solely to exercise the checker end-to-end; in a real deployment the receipt is
signed by the SEP-2828 issuer. The on-chain settlement values (txDigest, actual,
payTo) are REAL — they come from the live testnet settlement, not fixtures.
"""
import json, hashlib
from pathlib import Path
import rfc8785
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

ROOT = Path(__file__).resolve().parent
ACTION_KEYS = ("agentId", "actionType", "scope", "timestampMs", "seq", "terminal")
DECISION_BLOCKS = ("version", "alg", "backLink", "decisionDerived", "issuerAsserted")

def jcs(o): return rfc8785.dumps(o)
def sha(b): return "sha256:" + hashlib.sha256(b).hexdigest()

S = json.loads((ROOT / "session.json").read_text())

# throwaway demo issuer key (stands in for the real SEP-2828 issuer)
priv = ec.generate_private_key(ec.SECP256R1())
(ROOT / "keys").mkdir(parents=True, exist_ok=True)
(ROOT / "keys" / "es256_public.pem").write_bytes(priv.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))

def sign(obj):
    der = priv.sign(jcs(obj), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return r.to_bytes(32, "big").hex() + s.to_bytes(32, "big").hex()

COMMON = {
    "asset": S["asset"], "authorizedCeiling": S["authorizedCeiling"],
    "decimals": S["decimals"], "kwh": S["kwh"], "network": S["network"],
    "payTo": S["payTo"], "rail": "sui", "scheme": "upto",
}
# Phase 3: record the proof-of-personhood evidence in the bound settlement (#2677)
POR = S.get("por")
if POR:
    COMMON["por"] = {"credId": POR["credId"], "level": POR["level"]}
REASON = ("verified-human agent metered an EV charge within the authorized ceiling"
          if POR else "agent metered an EV charge within the authorized ceiling")
STEP0_BLOCK = {**COMMON, "amount": S["actual"], "assertedFrom": "operator-voucher",
               "session": S["sessionId"], "status": "in-progress",
               "voucherSig": S["voucherSig"], "voucherSigner": S["voucherSigner"]}
STEP1_BLOCK = {**COMMON, "amount": S["actual"], "assertedFrom": "net-balance-change-to-payTo",
               "session": S["sessionId"], "status": "finalized", "txDigest": S["txDigest"],
               "unusedCeiling": S["uncharged"], "verifiedBy": "facilitator://sui-exact"}

def settlement(seq, terminal, block):
    rec = {"actionType": S["actionType"], "agentId": S["agentId"],
           "schema": "x402.settlement.sui/v0", "scope": S["scope"],
           "seq": seq, "settlement": block, "terminal": terminal,
           "timestampMs": S["timestampMs"]}
    rec["actionRef"] = sha(jcs({k: rec[k] for k in ACTION_KEYS}))
    return rec

def receipt(stl, nonce, attest_nonce):
    r = {"version": 1, "alg": "ES256",
         "backLink": {"attestationDigest": sha(("attest|" + attest_nonce).encode()),
                      "attestationNonce": attest_nonce},
         "decisionDerived": {"decidedAt": "2026-06-25T00:00:00Z", "decision": "allow",
             "evidenceRef": {"canonicalization": "JCS", "digest": sha(jcs(stl)),
                 "ref": "x402:action_ref/" + stl["actionRef"], "schema": stl["schema"]},
             "policyId": "policy:x402-upto/1", "reason": REASON,
             "riskScore": "0.10", "thresholdAllow": "0.30", "thresholdBlock": "0.80"},
         "issuerAsserted": {"alg": "ES256", "iat": "2026-06-25T00:00:00Z",
             "iss": "issuer://demo-sep2828", "nonce": nonce, "secretVersion": "v1",
             "sub": S["agentId"]}}
    r["signature"] = sign({k: r[k] for k in DECISION_BLOCKS})
    return r

s0 = settlement(0, False, STEP0_BLOCK)
s1 = settlement(1, True, STEP1_BLOCK)
r0 = receipt(s0, "d-sui-0", "x402-charge-0")
r1 = receipt(s1, "d-sui-1", "x402-charge-1")

def w(rel, obj):
    p = ROOT / rel; p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n")

w("sui/step0/settlement.json", s0); w("sui/step0/receipt.json", r0)
w("sui/step1/settlement.json", s1); w("sui/step1/receipt.json", r1)
w("expected.json", {"sui": {"lifecycle_distinguishes_terminal": True,
    "step0": {"action_ref_recomputes": True, "receipt_signature_ok": True, "settlement_binding_resolves": True},
    "step1": {"action_ref_recomputes": True, "receipt_signature_ok": True, "settlement_binding_resolves": True}}})

print(f"built sui/upto charge vector — ceiling {S['authorizedCeiling']} actual {S['actual']} "
      f"({S['kwh']} kWh), tx {S['txDigest'][:12]}…")
print("step0 actionRef:", s0["actionRef"][:23], "…  step1 actionRef:", s1["actionRef"][:23], "…")
