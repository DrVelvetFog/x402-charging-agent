/**
 * The x402 <-> OCPI bridge — the charger side wired to a real charging network.
 *
 * This is the production-shaped version of the metered charger: instead of a
 * mock vehicle it drives an OCPI CPO (START_SESSION), and instead of self-
 * metering it settles against the CPO's CDR (Charge Detail Record) — the
 * network's signed billing truth. Everything else (the x402 `upto` voucher,
 * the on-chain settlement of the metered actual, the settlement-receipt vector)
 * is unchanged from Phase 2. Swapping the mock CPO for DeCharge/Starpower/etc.
 * is a base-URL + credentials change.
 *
 *   GET  /session                       402 upto terms (price/kWh, ceiling)
 *   POST /session/start   X-CHARGE-AUTH  verify ceiling voucher -> OCPI START_SESSION
 *   GET  /session/status                 poll: kWh so far / CDR ready / metered actual
 *   POST /session/settle  PAYMENT-SIGNATURE  settle the CDR's actual on-chain
 */
import http from "node:http";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { Requirements, SignedPayment, buildPayment, encodeHeader, decodeHeader, short } from "./lib.js";
import { amountForKwh } from "./metered.js";

async function sha256Hex(s: string): Promise<string> {
  const h = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s) as BufferSource);
  return "sha256:" + Buffer.from(new Uint8Array(h)).toString("hex");
}

export type OcpiBridgeConfig = {
  facilitatorUrl: string;
  network: string;
  asset: string;
  decimals: number;
  pricePerKwhAtomic: string;
  authorizedCeiling: string;
  payTo: string;
  cpoUrl: string; // base URL of the OCPI CPO
  cpoId: string; // "US/DEC"
  locationId: string;
  evseUid: string;
};

type ChargeAuth = { authB64: string; sig: string; signer: string };
type Sess = { sessionId: string; ocpiSessionId: string; scope: string; auth: ChargeAuth; authFields: any };

async function ocpiGet(base: string, path: string) {
  const r = await fetch(`${base}${path}`);
  return (await r.json())?.data;
}
async function ocpiPost(base: string, path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json())?.data;
}

export async function startOcpiCharger(cfg: OcpiBridgeConfig): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Map<string, Sess>();
  const price = BigInt(cfg.pricePerKwhAtomic);
  const ceiling = BigInt(cfg.authorizedCeiling);

  const terms = () => ({
    scheme: "upto", network: cfg.network, asset: cfg.asset, decimals: cfg.decimals,
    pricePerKwhAtomic: cfg.pricePerKwhAtomic, authorizedCeiling: cfg.authorizedCeiling,
    payTo: cfg.payTo, cpo: cfg.cpoId, locationId: cfg.locationId,
  });

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    });

  // pull the CDR and turn its total_energy into the x402 actual
  const settleFromCdr = async (ocpiSessionId: string) => {
    const cdr = await ocpiGet(cfg.cpoUrl, `/ocpi/2.2/cdrs/${ocpiSessionId}`);
    if (!cdr) return null;
    const kwh = Number(cdr.total_energy);
    const actual = amountForKwh(kwh, price, ceiling);
    return { cdr, kwh, actual };
  };

  const server = http.createServer(async (req, res) => {
    const send = (code: number, headers: Record<string, string>, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body));
    };
    const url = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && url === "/session") {
      const body = { x402Version: 2, error: "authorize a ceiling at POST /session/start", accepts: [terms()] };
      return send(402, { "PAYMENT-REQUIRED": encodeHeader(body) }, body);
    }

    if (req.method === "POST" && url === "/session/start") {
      const raw = req.headers["x-charge-auth"];
      if (typeof raw !== "string") return send(401, {}, { error: "X-CHARGE-AUTH required" });
      let auth: ChargeAuth;
      try { auth = decodeHeader<ChargeAuth>(raw); } catch { return send(400, {}, { error: "bad X-CHARGE-AUTH" }); }
      const msg = fromBase64(auth.authB64);
      const valid = await new Ed25519PublicKey(fromBase64(auth.signer)).verifyPersonalMessage(msg, auth.sig);
      if (!valid) return send(401, {}, { error: "voucher signature invalid" });
      const authFields = JSON.parse(new TextDecoder().decode(msg));
      if (BigInt(authFields.authorizedCeiling ?? 0) < ceiling) return send(402, {}, { error: "ceiling below terms" });

      // OCPI START_SESSION to the network
      const resp = await ocpiPost(cfg.cpoUrl, "/ocpi/2.2/commands/START_SESSION", {
        response_url: "x402-bridge://noop", token: { uid: "x402-bridge", type: "AD_HOC_USER" },
        location_id: cfg.locationId, evse_uid: cfg.evseUid,
      });
      if (resp?.result !== "ACCEPTED") return send(502, {}, { error: `CPO rejected START_SESSION: ${resp?.result}` });

      const sessionId = `chg_${Date.now().toString(36)}`;
      const scope = `cpo:${cfg.cpoId}/loc:${cfg.locationId}/session:${resp.session_id}/upto:${cfg.authorizedCeiling}atomic`;
      sessions.set(sessionId, { sessionId, ocpiSessionId: resp.session_id, scope, auth, authFields });
      return send(200, {}, { sessionId, ocpiSessionId: resp.session_id, scope });
    }

    if (req.method === "GET" && url === "/session/status") {
      const sid = new URL(req.url ?? "", "http://x").searchParams.get("sessionId") ?? "";
      const sess = sessions.get(sid);
      if (!sess) return send(404, {}, { error: "unknown session" });
      const s = await ocpiGet(cfg.cpoUrl, `/ocpi/2.2/sessions/${sess.ocpiSessionId}`);
      const cdrReady = s?.status === "COMPLETED";
      let kwh = Number(s?.kwh ?? 0), actual = "0";
      if (cdrReady) { const r = await settleFromCdr(sess.ocpiSessionId); if (r) { kwh = r.kwh; actual = r.actual.toString(); } }
      return send(200, {}, { state: s?.status ?? "UNKNOWN", kwh, actual, cdrReady });
    }

    if (req.method === "POST" && url === "/session/settle") {
      const body = await readBody(req);
      const sess = sessions.get(body.sessionId);
      if (!sess) return send(404, {}, { error: "unknown session" });
      const sig = req.headers["payment-signature"];
      if (typeof sig !== "string") return send(402, {}, { error: "PAYMENT-SIGNATURE required" });
      const r = await settleFromCdr(sess.ocpiSessionId);
      if (!r) return send(409, {}, { error: "CDR not ready" });

      const reqs: Requirements = {
        scheme: "exact", network: cfg.network, amount: r.actual.toString(), asset: cfg.asset,
        payTo: cfg.payTo, maxTimeoutSeconds: 60, extra: { kind: "ev-charge-ocpi", kwh: r.kwh.toFixed(3) },
      };
      let agentPayload: any;
      try { agentPayload = decodeHeader<any>(sig); } catch { return send(400, {}, { error: "bad PAYMENT-SIGNATURE" }); }
      let settle: any;
      try {
        settle = await (await fetch(`${cfg.facilitatorUrl}/settle`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, accepted: reqs, payload: agentPayload.payload }, paymentRequirements: reqs }),
        })).json();
      } catch (e: any) { return send(502, {}, { error: `facilitator unreachable: ${e?.message ?? e}` }); }
      if (!settle?.success) return send(402, {}, { error: settle?.errorReason ?? "settlement failed" });

      const uncharged = ceiling - r.actual;
      const sd = JSON.stringify(r.cdr.signed_data);
      const finalized = {
        sessionId: sess.sessionId, scope: sess.scope, agentId: sess.authFields.agentId,
        kwh: r.kwh.toFixed(3), authorizedCeiling: cfg.authorizedCeiling, actual: r.actual.toString(),
        uncharged: uncharged.toString(), asset: cfg.asset, decimals: cfg.decimals, network: cfg.network,
        payTo: cfg.payTo, txDigest: settle.transaction, timestampMs: Number(sess.authFields.ts),
        voucherSig: sess.auth.sig, voucherSigner: sess.authFields.signerAddr,
        cdr: { cpo: cfg.cpoId, cdrId: r.cdr.id, ocpiSessionId: sess.ocpiSessionId, totalEnergyKwh: String(r.cdr.total_energy), signedDataDigest: await sha256Hex(sd) },
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
export async function runOcpiAgent(
  chargerUrl: string,
  client: SuiJsonRpcClient,
  car: Ed25519Keypair,
  budgetAtomic: bigint,
  onStep: (msg: string) => void = () => {},
): Promise<{ finalized: any; digest: string }> {
  const terms: any = (await (await fetch(`${chargerUrl}/session`)).json()).accepts[0];
  const ceiling = BigInt(terms.authorizedCeiling);
  onStep(`402 upto terms — ${terms.pricePerKwhAtomic} atomic/kWh, ceiling ${terms.authorizedCeiling}, CPO ${terms.cpo}`);
  if (ceiling > budgetAtomic) throw new Error(`ceiling ${ceiling} exceeds budget ${budgetAtomic} — declining`);

  const ts = Date.now();
  const agentId = `agent:ev:${car.toSuiAddress().slice(0, 10)}`;
  const authObj = { agentId, authorizedCeiling: terms.authorizedCeiling, payTo: terms.payTo, signerAddr: car.toSuiAddress(), ts };
  const authBytes = new TextEncoder().encode(JSON.stringify(authObj));
  const { signature } = await car.signPersonalMessage(authBytes);
  const auth = { authB64: toBase64(authBytes), sig: signature, signer: car.getPublicKey().toBase64() };
  onStep(`signed ceiling voucher (up to ${terms.authorizedCeiling})`);

  const startRes = await fetch(`${chargerUrl}/session/start`, { method: "POST", headers: { "x-charge-auth": encodeHeader(auth) } });
  if (startRes.status !== 200) throw new Error(`start rejected (${startRes.status}): ${await startRes.text()}`);
  const session: any = await startRes.json();
  onStep(`OCPI session ${session.ocpiSessionId} started at the network`);

  let status: any = { cdrReady: false, kwh: 0, actual: "0" };
  for (let i = 0; i < 60; i++) {
    status = await (await fetch(`${chargerUrl}/session/status?sessionId=${session.sessionId}`)).json();
    onStep(`metering (OCPI) — ${status.kwh} kWh (${status.state})`);
    if (status.cdrReady) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!status.cdrReady) throw new Error("CDR never became ready");
  const actual = BigInt(status.actual);
  onStep(`CDR ready — ${status.kwh} kWh → actual ${actual} atomic (uncharged ${ceiling - actual})`);

  const payload: SignedPayment = await buildPayment(client, car, terms.payTo, actual, terms.asset);
  const settleRes = await fetch(`${chargerUrl}/session/settle`, {
    method: "POST", headers: { "content-type": "application/json", "payment-signature": encodeHeader({ payload }) },
    body: JSON.stringify({ sessionId: session.sessionId }),
  });
  if (settleRes.status !== 200) throw new Error(`settle rejected (${settleRes.status}): ${await settleRes.text()}`);
  const finalized: any = await settleRes.json();
  onStep(`settled CDR actual on Sui (digest ${short(finalized.txDigest)})`);
  return { finalized, digest: finalized.txDigest };
}
