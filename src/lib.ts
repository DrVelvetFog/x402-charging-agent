/**
 * Shared x402-on-Sui helpers.
 *
 * Vendored, near-verbatim, from x402-sui-stack/examples/quickstart/lib.ts (the
 * stack's seller explicitly invites "copy it to add per-call payment to your own
 * API"). Only change: .secrets/ now resolves to the repo root. The payment path
 * (buildPayment) traces back to the facilitator's own e2e test; the on-chain
 * recompute mirrors the x402-conformance MCP, so "verify" means the same thing
 * here as in the rest of the toolchain.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

export const SUI = "0x2::sui::SUI";
export const USDC =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC"; // testnet
export const USDC_MAINNET =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
export const TESTNET_RPC = "https://fullnode.testnet.sui.io:443";
export const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";

const isMainnet = (network: string) => network === "sui:mainnet";
export const rpcFor = (network: string) => (isMainnet(network) ? MAINNET_RPC : TESTNET_RPC);
export const usdcFor = (network: string) => (isMainnet(network) ? USDC_MAINNET : USDC);

export type Requirements = {
  scheme: "exact";
  network: string;
  amount: string; // atomic units, as a string
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};
export type SignedPayment = { transaction: string; signature: string };

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");

/**
 * gRPC client behind the JSON-RPC-shaped calls this repo already makes
 * (JSON-RPC is retired everywhere; gRPC lives on the same fullnode hosts).
 */
export class ChargeClient {
  readonly grpc: SuiGrpcClient;
  constructor(network: "mainnet" | "testnet", baseUrl: string) {
    this.grpc = new SuiGrpcClient({ network, baseUrl });
  }
  async getBalance(input: { owner: string; coinType?: string }): Promise<{ totalBalance: string }> {
    const r = await this.grpc.core.getBalance(input);
    return { totalBalance: r.balance.balance };
  }
  async getCoins(input: { owner: string; coinType?: string }): Promise<{ data: { coinObjectId: string; balance: string }[] }> {
    const r = await this.grpc.core.listCoins(input);
    return { data: (r.objects as any[]).map((o: any) => ({ coinObjectId: o.objectId, balance: o.balance })) };
  }
  async waitForTransaction(input: { digest: string; timeout?: number }): Promise<{ digest: string }> {
    const r: any = await this.grpc.waitForTransaction({ digest: input.digest, timeout: input.timeout });
    const tx: any = r?.$kind === "Transaction" ? r.Transaction : r?.FailedTransaction ?? r;
    return { digest: tx?.digest ?? input.digest };
  }
  async getLatestSuiSystemState(): Promise<{ epoch: string }> {
    const r = await this.grpc.core.getCurrentSystemState();
    return { epoch: String(r.systemState.epoch) };
  }
  async getChainIdentifier(): Promise<string> {
    return (await this.grpc.core.getChainIdentifier()).chainIdentifier;
  }
}

export function getClient(network = "sui:testnet"): ChargeClient {
  return new ChargeClient(isMainnet(network) ? "mainnet" : "testnet", process.env.SUI_RPC ?? rpcFor(network));
}

/** Load (or create) a persisted testnet keypair under .secrets/ (gitignored). */
export function loadKeypair(name: string): Ed25519Keypair {
  const file = path.join(secretsDir, `${name}.key`);
  if (fs.existsSync(file)) return Ed25519Keypair.fromSecretKey(fs.readFileSync(file, "utf8").trim());
  fs.mkdirSync(secretsDir, { recursive: true });
  const kp = new Ed25519Keypair();
  fs.writeFileSync(file, kp.getSecretKey(), { mode: 0o600 });
  return kp;
}

/** Best-effort testnet SUI faucet so the payer has gas (and SUI to spend). */
export async function ensureGas(
  client: ChargeClient,
  addr: string,
  network = "sui:testnet",
): Promise<bigint> {
  let bal = BigInt((await client.getBalance({ owner: addr })).totalBalance);
  if (bal >= 50_000_000n) return bal;
  if (isMainnet(network)) {
    if (bal < 10_000_000n)
      throw new Error(`payer ${addr} has no mainnet SUI for gas (${bal} MIST) — fund it; there is no mainnet faucet`);
    return bal;
  }
  try {
    await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: addr });
    await new Promise((r) => setTimeout(r, 3000));
    bal = BigInt((await client.getBalance({ owner: addr })).totalBalance);
  } catch (e: any) {
    if (bal < 10_000_000n) throw new Error(`payer ${addr} is dry and the faucet refused: ${e?.message ?? e}`);
  }
  return bal;
}

/** Build + sign a payment of `amount` of `asset` from `payer` to `to`. */
export async function buildPayment(
  client: ChargeClient,
  payer: Ed25519Keypair,
  to: string,
  amount: bigint,
  asset: string,
): Promise<SignedPayment> {
  const tx = new Transaction();
  tx.setSender(payer.toSuiAddress());
  // The Sui exact scheme (x402 #3081) requires a ValidDuring expiration;
  // conformant facilitators reject a payment without one.
  const [state, chain] = await Promise.all([
    client.getLatestSuiSystemState(),
    client.getChainIdentifier(),
  ]);
  const epoch = BigInt(state.epoch);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(epoch),
      maxEpoch: String(epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain,
      nonce: Math.floor(Math.random() * 4294967296),
    },
  });
  if (asset === SUI) {
    const [coin] = tx.splitCoins(tx.gas, [amount]);
    tx.transferObjects([coin], to);
  } else {
    const coins = await client.getCoins({ owner: payer.toSuiAddress(), coinType: asset });
    const total = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
    if (total < amount) {
      throw new Error(
        `payer ${payer.toSuiAddress()} holds ${total} of ${asset}, needs ${amount} — fund testnet USDC at https://faucet.circle.com`,
      );
    }
    const [first, ...rest] = coins.data;
    if (rest.length && BigInt(first.balance) < amount) {
      tx.mergeCoins(tx.object(first.coinObjectId), rest.map((c) => tx.object(c.coinObjectId)));
    }
    const [coin] = tx.splitCoins(tx.object(first.coinObjectId), [amount]);
    tx.transferObjects([coin], to);
  }
  const bytes = await tx.build({ client: client.grpc });
  const { signature } = await payer.signTransaction(bytes);
  return { transaction: toBase64(bytes), signature };
}

/** x402 carries JSON in HTTP headers as base64. */
export const encodeHeader = (obj: unknown): string =>
  toBase64(new TextEncoder().encode(JSON.stringify(obj)));
export const decodeHeader = <T>(b64: string): T =>
  JSON.parse(new TextDecoder().decode(fromBase64(b64))) as T;

/**
 * Independent on-chain recompute: net `asset` credited to `payTo` by `digest`.
 * Raw JSON-RPC (sui_getTransactionBlock) — the same check the conformance MCP
 * makes. "Don't trust the operator, recompute it."
 */
export async function onchainNetToPayTo(
  rpcUrl: string,
  digest: string,
  payTo: string,
  asset: string,
): Promise<bigint> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "sui_getTransactionBlock",
    params: [digest, { showBalanceChanges: true, showEffects: true }],
  };
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  const bc: any[] = json?.result?.balanceChanges ?? [];
  const eq = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  let net = 0n;
  for (const c of bc) {
    const owner = c?.owner?.AddressOwner ?? c?.owner?.addressOwner ?? c?.owner;
    if (eq(owner, payTo) && eq(c?.coinType, asset)) net += BigInt(c.amount);
  }
  return net;
}

export const explorerUrl = (network: string, digest: string) =>
  isMainnet(network)
    ? `https://suivision.xyz/txblock/${digest}`
    : `https://testnet.suivision.xyz/txblock/${digest}`;
export const short = (s: string) => (s && s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);
