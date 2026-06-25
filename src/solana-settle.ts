/**
 * Solana devnet settlement rail for the charging agent.
 *
 * The Sui demos settle via the Sui facilitator; a DePIN pilot (DeCharge,
 * Starpower, PowerPod) settles on Solana. This is the minimal honest Solana leg:
 * the on-chain finalize of the metered actual, as a real devnet transaction with
 * an independent recompute — the same shape as the Sui side (the `upto` ceiling
 * lives at the voucher/receipt layer; the on-chain leg transfers the actual).
 *
 * Turnkey on devnet: SOL via airdrop, like the Sui demo's SUI default. Production
 * settles USDC (SPL) through an x402 SVM facilitator (the `upto` pay-kit / the
 * SVM scheme being standardized with the Solana Foundation) — a rail swap, not a
 * model change.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, clusterApiUrl,
} from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOLANA_RPC = process.env.SOLANA_RPC ?? clusterApiUrl("devnet");
export const conn = () => new Connection(SOLANA_RPC, "confirmed");

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");

/** Load (or create) a persisted Solana keypair under .secrets/ (gitignored). */
export function loadSolanaKeypair(name: string): Keypair {
  const file = path.join(secretsDir, `${name}.key`);
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"));
  fs.mkdirSync(secretsDir, { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(file, Buffer.from(kp.secretKey).toString("base64"), { mode: 0o600 });
  return kp;
}

/** Best-effort devnet airdrop so the payer has lamports to spend + pay fees. */
export async function ensureSol(c: Connection, pubkey: PublicKey, minLamports = 20_000_000): Promise<number> {
  let bal = await c.getBalance(pubkey);
  for (let i = 0; i < 4 && bal < minLamports; i++) {
    try {
      const sig = await c.requestAirdrop(pubkey, 100_000_000); // 0.1 SOL
      const bh = await c.getLatestBlockhash();
      await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
    bal = await c.getBalance(pubkey);
  }
  if (bal < minLamports) throw new Error(`devnet airdrop failed for ${pubkey.toBase58()} (have ${bal} lamports) — retry later or fund manually`);
  return bal;
}

/** Settle `lamports` from `from` to `to` on devnet. Returns the real tx signature. */
export async function settleSol(c: Connection, from: Keypair, to: PublicKey, lamports: bigint): Promise<string> {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Number(lamports) }));
  return sendAndConfirmTransaction(c, tx, [from], { commitment: "confirmed" });
}

/** Independent recompute: net lamports credited to `payee` by `sig` (from the tx's own balance deltas). */
export async function recomputeSolToPayee(c: Connection, sig: string, payee: PublicKey): Promise<bigint> {
  const tx = await c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx?.meta) return 0n;
  const keys = tx.transaction.message.accountKeys.map((k: any) => (k.pubkey?.toBase58?.() ?? k.toBase58?.() ?? String(k)));
  const i = keys.indexOf(payee.toBase58());
  if (i < 0) return 0n;
  return BigInt(tx.meta.postBalances[i] - tx.meta.preBalances[i]);
}

export const solExplorer = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=${SOLANA_RPC.includes("devnet") ? "devnet" : "custom"}`;
