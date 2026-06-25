/**
 * A mock Tesla vehicle that speaks the same HTTP contract as Tesla's
 * `tesla-http-proxy` (from teslamotors/vehicle-command). It implements just the
 * charging slice of the Fleet API command surface:
 *
 *   POST /api/1/vehicles/:vin/command/charge_start
 *   POST /api/1/vehicles/:vin/command/charge_stop
 *   POST /api/1/vehicles/:vin/command/set_charging_amps   { charging_amps }
 *   POST /api/1/vehicles/:vin/command/set_charge_limit     { percent }
 *   GET  /api/1/vehicles/:vin/vehicle_data                 -> { response: { charge_state } }
 *
 * Commands return Tesla's `{ "response": { "result": true, "reason": "" } }`
 * shape. State-of-charge ramps deterministically from elapsed time while
 * charging, so the demo shows the battery actually filling. Because the contract
 * matches the real proxy, Phase 4 swaps this for `tesla-http-proxy` + a real car
 * by changing one base URL — no change to the payment loop.
 */
import http from "node:http";

type ChargingState = "Disconnected" | "Stopped" | "Charging" | "Complete";

type VehicleState = {
  battery_level: number; // last materialized %
  charge_limit_soc: number; // target %
  charging_state: ChargingState;
  charger_actual_current: number; // amps
  _amps: number;
  _since: number | null; // ms when charging began
  _levelAtStart: number;
  _ratePctPerSec: number;
};

export type MockVehicleConfig = {
  vin?: string;
  startSoc?: number; // %
  chargeLimit?: number; // %
  ratePctPerSec?: number; // how fast SoC climbs while charging
};

const ok = { response: { result: true, reason: "" } };
const fail = (reason: string) => ({ response: { result: false, reason } });

export async function startMockVehicle(
  cfg: MockVehicleConfig = {},
): Promise<{ url: string; vin: string; close: () => Promise<void> }> {
  const vin = cfg.vin ?? "5YJ3MOCK000000001";
  const v: VehicleState = {
    battery_level: cfg.startSoc ?? 42,
    charge_limit_soc: cfg.chargeLimit ?? 80,
    charging_state: "Stopped",
    charger_actual_current: 0,
    _amps: 16,
    _since: null,
    _levelAtStart: cfg.startSoc ?? 42,
    _ratePctPerSec: cfg.ratePctPerSec ?? 3,
  };

  // Fold elapsed charging time into battery_level; auto-complete at the limit.
  const materialize = () => {
    if (v.charging_state === "Charging" && v._since != null) {
      const elapsed = (Date.now() - v._since) / 1000;
      const level = Math.min(v.charge_limit_soc, v._levelAtStart + v._ratePctPerSec * elapsed);
      v.battery_level = Math.round(level * 10) / 10;
      if (v.battery_level >= v.charge_limit_soc) {
        v.battery_level = v.charge_limit_soc;
        v.charging_state = "Complete";
        v.charger_actual_current = 0;
        v._since = null;
      }
    }
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";

    // GET vehicle_data
    const dataMatch = url.match(/^\/api\/1\/vehicles\/([^/]+)\/vehicle_data$/);
    if (req.method === "GET" && dataMatch) {
      materialize();
      return send(200, {
        response: {
          vin,
          charge_state: {
            battery_level: v.battery_level,
            charge_limit_soc: v.charge_limit_soc,
            charging_state: v.charging_state,
            charger_actual_current: v.charger_actual_current,
          },
        },
      });
    }

    // POST command
    const cmdMatch = url.match(/^\/api\/1\/vehicles\/([^/]+)\/command\/([a-z_]+)$/);
    if (req.method === "POST" && cmdMatch) {
      const cmd = cmdMatch[2];
      const body = await readBody(req);
      materialize();
      switch (cmd) {
        case "charge_start":
          if (v.charging_state === "Charging") return send(200, fail("already charging"));
          if (v.battery_level >= v.charge_limit_soc) return send(200, fail("complete"));
          v.charging_state = "Charging";
          v._since = Date.now();
          v._levelAtStart = v.battery_level;
          v.charger_actual_current = v._amps;
          return send(200, ok);
        case "charge_stop":
          v.charging_state = "Stopped";
          v.charger_actual_current = 0;
          v._since = null;
          return send(200, ok);
        case "set_charging_amps": {
          const amps = Number(body.charging_amps ?? body.amps ?? 0);
          if (!Number.isFinite(amps) || amps <= 0) return send(200, fail("invalid amps"));
          v._amps = amps;
          if (v.charging_state === "Charging") v.charger_actual_current = amps;
          return send(200, ok);
        }
        case "set_charge_limit": {
          const pct = Number(body.percent ?? body.charge_limit_soc ?? 0);
          if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return send(200, fail("invalid percent"));
          v.charge_limit_soc = pct;
          return send(200, ok);
        }
        default:
          return send(200, fail(`unsupported command: ${cmd}`));
      }
    }

    return send(404, { error: "not found", path: url });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    vin,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
