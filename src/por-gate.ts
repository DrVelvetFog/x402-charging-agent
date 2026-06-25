/**
 * Phase 3 — proof-of-personhood gate (the #2677 pattern: only a verified human's
 * agent may charge).
 *
 * `verifyPorVc` is vendored near-verbatim from por-sdk (src/index.ts) — it's pure
 * WebCrypto (no @mysten/sui), so vendoring avoids pulling a second major version
 * of the Sui SDK just to check a credential. The gate verifies a PoR SD-JWT-VC
 * offline and binds the credential's subject to the *paying wallet*, so a human's
 * credential can't be lent to a different payer.
 *
 * The issuer here is a clearly-labelled DEMO issuer (its own throwaway Ed25519
 * key + a local JWKS endpoint), exactly as the real PoR attestor would sign in
 * production. Going live = point `jwksUrl` at the real attestor's well-known JWKS
 * (or gate on-chain with por-sdk's `PorClient.isVerified`). No change to the gate
 * logic.
 */
import http from "node:http";

// ---- base64url + hashing helpers (vendored from por-sdk) ----
const b64urlToBytes = (s: string): Uint8Array => {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToString = (s: string) => new TextDecoder().decode(b64urlToBytes(s));
const bytesToB64url = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const strToB64url = (s: string) => bytesToB64url(new TextEncoder().encode(s));
async function sha256B64url(input: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input) as BufferSource);
  return bytesToB64url(new Uint8Array(hash));
}

export interface PorVcResult {
  valid: true;
  issuer: string;
  subject: string;
  address: string;
  credId: string;
  network: string;
  claims: Record<string, unknown>;
  expiresAtMs?: number;
}

/** Verify a PoR SD-JWT-VC fully offline (EdDSA over the issuer's JWKS, expiry,
 *  and that every disclosure is committed in `_sd`). Vendored from por-sdk. */
export async function verifyPorVc(sdjwt: string, opts: { jwksUrl: string; now?: number }): Promise<PorVcResult> {
  const [jwt, ...disclosures] = sdjwt.split("~");
  const discs = disclosures.filter(Boolean);
  const [h, p, sig] = jwt.split(".");
  const header = JSON.parse(b64urlToString(h));
  const payload = JSON.parse(b64urlToString(p));

  const { keys } = await (await fetch(opts.jwksUrl)).json();
  const jwk = keys.find((k: { kid?: string }) => k.kid === header.kid) ?? keys[0];
  const key = await globalThis.crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"],
  );
  const ok = await globalThis.crypto.subtle.verify(
    "Ed25519", key, b64urlToBytes(sig) as BufferSource, new TextEncoder().encode(`${h}.${p}`) as BufferSource,
  );
  if (!ok) throw new Error("PoR VC signature invalid");

  const now = opts.now ?? Date.now();
  if (payload.exp && now / 1000 >= payload.exp) throw new Error("PoR VC expired");

  const sd: string[] = payload._sd ?? [];
  const claims: Record<string, unknown> = {};
  for (const disc of discs) {
    if (!sd.includes(await sha256B64url(disc))) throw new Error("disclosure not committed in _sd");
    const [, name, value] = JSON.parse(b64urlToString(disc));
    claims[name] = value;
  }

  return {
    valid: true,
    issuer: payload.iss,
    subject: payload.sub,
    address: String(payload.sub).split(":").pop() as string,
    credId: payload.por?.credId,
    network: payload.por?.network,
    claims,
    expiresAtMs: payload.exp ? payload.exp * 1000 : undefined,
  };
}

/** Verify a VC AND bind it to the expected payer; enforce uniqueness + min level. */
export async function requirePor(
  sdjwt: string,
  jwksUrl: string,
  expectedAddress: string,
  minLevel = 0,
): Promise<{ credId: string; level: number; subject: string }> {
  const r = await verifyPorVc(sdjwt, { jwksUrl });
  if (r.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(`PoR subject ${r.address} is not the paying wallet ${expectedAddress}`);
  }
  if (r.claims.unique !== true) throw new Error("PoR credential does not assert a unique human");
  const level = Number(r.claims.level ?? 0);
  if (level < minLevel) throw new Error(`PoR level ${level} below required ${minLevel}`);
  return { credId: r.credId, level, subject: r.subject };
}

// ---------------------------------------------------------- demo issuer ----
/** A throwaway PoR issuer: signs SD-JWT-VCs with its own Ed25519 key and serves
 *  the matching JWKS. Stands in for the real PoR attestor for a turnkey demo. */
export async function startPorIssuer(network = "sui:testnet"): Promise<{
  jwksUrl: string;
  issueVc: (address: string, opts?: { unique?: boolean; level?: number; ttlMs?: number }) => Promise<string>;
  close: () => Promise<void>;
}> {
  const kid = "demo-por-issuer-1";
  const kp = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk: any = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  const jwks = { keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid, use: "sig", alg: "EdDSA" }] };

  const server = http.createServer((req, res) => {
    if ((req.url ?? "").endsWith("/.well-known/jwks.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(jwks));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const issueVc = async (address: string, opts: { unique?: boolean; level?: number; ttlMs?: number } = {}) => {
    const unique = opts.unique ?? true;
    const level = opts.level ?? 0; // L0 DeviceHuman by default
    const ttlMs = opts.ttlMs ?? 3600_000;
    const claims: Array<[string, unknown]> = [["unique", unique], ["level", level]];
    const sd: string[] = [];
    const discs: string[] = [];
    for (const [name, value] of claims) {
      const salt = bytesToB64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
      const disc = strToB64url(JSON.stringify([salt, name, value]));
      discs.push(disc);
      sd.push(await sha256B64url(disc));
    }
    const header = { alg: "EdDSA", typ: "vc+sd-jwt", kid };
    const payload = {
      iss: `${base} (DEMO PoR issuer)`,
      sub: `did:pkh:sui:${address}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((Date.now() + ttlMs) / 1000),
      _sd: sd,
      por: { credId: `por:demo:${address.slice(0, 10)}`, network },
    };
    const signingInput = `${strToB64url(JSON.stringify(header))}.${strToB64url(JSON.stringify(payload))}`;
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(signingInput) as BufferSource),
    );
    return `${signingInput}.${bytesToB64url(sig)}~${discs.join("~")}~`;
  };

  return { jwksUrl: `${base}/.well-known/jwks.json`, issueVc, close: () => new Promise<void>((r) => server.close(() => r())) };
}
