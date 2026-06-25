/**
 * A mock OCPI 2.2 CPO (charge point operator / charging network).
 *
 * Speaks the real OCPI objects so the x402 bridge talks to it the way it would
 * talk to a DePIN charging network (DeCharge, Starpower, PowerPod…):
 *
 *   POST /ocpi/2.2/commands/START_SESSION   StartSession -> CommandResponse(ACCEPTED)
 *   GET  /ocpi/2.2/sessions/:id             live Session (status + kWh so far)
 *   GET  /ocpi/2.2/cdrs/:session_id         the CDR once COMPLETED — the billing
 *                                            truth: total_energy, charging_periods,
 *                                            and signed_data (signed meter values)
 *
 * Energy meters deterministically from elapsed time and auto-completes at the
 * target, producing a CDR whose total_energy is the metered actual the bridge
 * settles against. signed_data carries a real Ed25519 signature over the meter
 * readings — a stand-in for OCPI/Eichrecht signed meter data, so the bridge can
 * bind the network's own signed billing record into the x402 receipt.
 */
import http from "node:http";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

type SessionState = {
  id: string;
  status: "ACTIVE" | "COMPLETED";
  startMs: number;
  ratePerSec: number; // kWh/s
  targetKwh: number;
  currency: string;
  pricePerKwhFiat: number;
  locationId: string;
  evseUid: string;
};

export async function startOcpiCpo(
  cfg: { countryCode?: string; partyId?: string; ratePerSec?: number; targetKwh?: number; currency?: string; pricePerKwhFiat?: number } = {},
): Promise<{ url: string; cpo: string; close: () => Promise<void> }> {
  const countryCode = cfg.countryCode ?? "US";
  const partyId = cfg.partyId ?? "DEC"; // e.g. a DeCharge-like party id
  const ratePerSec = cfg.ratePerSec ?? 2.5;
  const targetKwh = cfg.targetKwh ?? 10;
  const currency = cfg.currency ?? "USD";
  const pricePerKwhFiat = cfg.pricePerKwhFiat ?? 0.3;

  // CPO signing key for signed meter data (stand-in for OCMF/Eichrecht)
  const kp = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubJwk: any = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);

  const sessions = new Map<string, SessionState>();
  const materialize = (s: SessionState) => {
    const kwh = Math.min(s.targetKwh, ratePerSec * ((Date.now() - s.startMs) / 1000));
    if (kwh >= s.targetKwh) s.status = "COMPLETED";
    return Math.round(kwh * 1000) / 1000;
  };

  const sign = async (msg: string) =>
    b64(new Uint8Array(await globalThis.crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg) as BufferSource)));

  const cdrFor = async (s: SessionState) => {
    const energy = s.targetKwh;
    const startIso = new Date(s.startMs).toISOString();
    const endIso = new Date().toISOString();
    const meterMsg = `OCMF|session:${s.id}|start:0.000|end:${energy.toFixed(3)}|unit:kWh`;
    const cost = +(energy * s.pricePerKwhFiat).toFixed(2);
    return {
      id: `CDR-${s.id}`,
      session_id: s.id,
      country_code: countryCode,
      party_id: partyId,
      start_date_time: startIso,
      end_date_time: endIso,
      cdr_token: { uid: "x402-bridge", type: "AD_HOC_USER", contract_id: "x402" },
      auth_method: "COMMAND",
      currency,
      total_energy: energy, // kWh — the billing truth
      total_time: +(((Date.now() - s.startMs) / 3_600_000)).toFixed(4),
      total_cost: { excl_vat: cost, incl_vat: +(cost * 1.0).toFixed(2) },
      charging_periods: [
        { start_date_time: startIso, dimensions: [{ type: "ENERGY", volume: energy }] },
      ],
      signed_data: {
        encoding_method: "Ed25519-demo",
        public_key: pubJwk.x,
        signed_values: [{ nature: "END", plain_data: meterMsg, signed_data: await sign(meterMsg) }],
      },
      last_updated: endIso,
    };
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
      });
    });

  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ status_code: 1000, timestamp: new Date().toISOString(), data: body }));
    };
    const url = (req.url ?? "").split("?")[0];

    if (req.method === "POST" && url === "/ocpi/2.2/commands/START_SESSION") {
      const cmd = await readBody(req); // StartSession { response_url, token, location_id, evse_uid }
      const id = `S-${Date.now().toString(36)}`;
      sessions.set(id, {
        id, status: "ACTIVE", startMs: Date.now(), ratePerSec, targetKwh, currency, pricePerKwhFiat,
        locationId: cmd.location_id ?? "LOC1", evseUid: cmd.evse_uid ?? "EVSE1",
      });
      // real OCPI returns session_id async via the Sessions push; the mock returns it inline
      return send(200, { result: "ACCEPTED", timeout: 30, session_id: id });
    }

    const sMatch = url.match(/^\/ocpi\/2\.2\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sMatch) {
      const s = sessions.get(sMatch[1]);
      if (!s) return send(404, { error: "unknown session" });
      const kwh = materialize(s);
      return send(200, { id: s.id, status: s.status, kwh, total_energy: kwh, currency: s.currency });
    }

    const cMatch = url.match(/^\/ocpi\/2\.2\/cdrs\/([^/]+)$/);
    if (req.method === "GET" && cMatch) {
      const s = sessions.get(cMatch[1]);
      if (!s) return send(404, { error: "unknown session" });
      materialize(s);
      if (s.status !== "COMPLETED") return send(409, { error: "session not complete; no CDR yet" });
      return send(200, await cdrFor(s));
    }

    return send(404, { error: "not found", path: url });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, cpo: `${countryCode}/${partyId}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
