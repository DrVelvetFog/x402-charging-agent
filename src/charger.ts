/**
 * An x402-gated charging station (the "energy seller").
 *
 * Adapted from x402-sui-stack's seller.ts. The difference: a settled payment
 * doesn't return data — it authorizes a *physical action*. On successful
 * settlement the charger drives the vehicle over Tesla's command contract
 * (set_charge_limit -> set_charging_amps -> charge_start) and returns the
 * session, with the on-chain settlement digest in PAYMENT-RESPONSE.
 *
 *   GET /session                      unpaid  -> 402 + terms (PAYMENT-REQUIRED)
 *   GET /session  + PAYMENT-SIGNATURE  paid   -> settle, start charging, 200 + session
 *
 * The charger settles against ITS OWN terms — it never trusts the amount/payTo
 * the agent declares, only the signed transaction bytes the agent provides.
 */
import http from "node:http";
import { Requirements, SignedPayment, encodeHeader, decodeHeader } from "./lib.js";

export type ChargerConfig = {
  facilitatorUrl: string;
  network: string;
  asset: string;
  amount: string; // atomic units — the session price
  payTo: string; // charging-station operator address
  vehicleUrl: string; // base URL of the vehicle (mock now, tesla-http-proxy later)
  vin: string;
  chargeToPct: number; // session target SoC
  amps: number; // charge current to request
  kwh: number; // energy this session sells (label/narrative; metered for real in Phase 2)
};

type PaymentPayload = {
  x402Version: 2;
  resource: { url: string; description: string; mimeType: string };
  accepted: Requirements;
  payload: SignedPayment;
};

async function vehicleCmd(base: string, vin: string, cmd: string, body?: unknown) {
  const r = await fetch(`${base}/api/1/vehicles/${vin}/command/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return (await r.json()) as { response?: { result?: boolean; reason?: string } };
}

export async function startCharger(
  cfg: ChargerConfig,
): Promise<{ url: string; close: () => Promise<void> }> {
  const resource = {
    url: `x402-charging://station/${cfg.vin}`,
    description: `EV charge session: up to ${cfg.kwh} kWh to ${cfg.chargeToPct}% at ${cfg.amps}A`,
    mimeType: "application/json",
  };
  const requirements = (): Requirements => ({
    scheme: "exact",
    network: cfg.network,
    amount: cfg.amount,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    extra: { kind: "ev-charge", kwh: cfg.kwh, chargeToPct: cfg.chargeToPct, amps: cfg.amps },
  });

  const server = http.createServer(async (req, res) => {
    const send = (code: number, headers: Record<string, string>, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    const sig = req.headers["payment-signature"];

    // unpaid -> 402 with the terms
    if (typeof sig !== "string" || !sig.length) {
      const body = {
        x402Version: 2,
        error: "PAYMENT-SIGNATURE header is required",
        resource,
        accepts: [requirements()],
      };
      return send(402, { "PAYMENT-REQUIRED": encodeHeader(body) }, body);
    }

    // paid attempt -> settle the agent's signed tx against our own terms
    let agent: PaymentPayload;
    try {
      agent = decodeHeader<PaymentPayload>(sig);
    } catch {
      return send(400, {}, { error: "PAYMENT-SIGNATURE is not valid base64 JSON" });
    }
    const reqs = requirements();
    const settleBody = {
      x402Version: 2,
      paymentPayload: { x402Version: 2, resource, accepted: reqs, payload: agent.payload },
      paymentRequirements: reqs,
    };
    let settle: any;
    try {
      settle = await (
        await fetch(`${cfg.facilitatorUrl}/settle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settleBody),
        })
      ).json();
    } catch (e: any) {
      return send(502, {}, { error: `facilitator unreachable: ${e?.message ?? e}` });
    }
    if (!settle?.success) {
      const body = { x402Version: 2, error: settle?.errorReason ?? "settlement failed", resource, accepts: [reqs] };
      return send(402, { "PAYMENT-REQUIRED": encodeHeader(body) }, body);
    }

    // settled -> authorize the physical action: start charging the car
    try {
      await vehicleCmd(cfg.vehicleUrl, cfg.vin, "set_charge_limit", { percent: cfg.chargeToPct });
      await vehicleCmd(cfg.vehicleUrl, cfg.vin, "set_charging_amps", { charging_amps: cfg.amps });
      const start = await vehicleCmd(cfg.vehicleUrl, cfg.vin, "charge_start");
      if (!start.response?.result) {
        return send(409, {}, { error: `vehicle refused charge_start: ${start.response?.reason ?? "unknown"}` });
      }
    } catch (e: any) {
      return send(502, {}, { error: `vehicle unreachable: ${e?.message ?? e}` });
    }

    const session = {
      sessionId: `chg_${Date.now().toString(36)}`,
      vin: cfg.vin,
      chargeToPct: cfg.chargeToPct,
      amps: cfg.amps,
      kwh: cfg.kwh,
      settlementDigest: settle.transaction,
      startedAt: new Date().toISOString(),
    };
    return send(200, { "PAYMENT-RESPONSE": encodeHeader(settle) }, session);
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/session`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
