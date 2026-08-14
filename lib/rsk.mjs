// Rootstock helpers. The only real deviation from Ethereum is that RSK does NOT support
// EIP-1559 — send legacy `type: 0` transactions with an explicit `gasPrice`, otherwise
// ethers builds a 1559 envelope the node rejects. Everything else (Cancun opcodes since
// Lovell Feb 2024, precompile 0x02 SHA-256, block.timestamp semantics) is identical.
import { readFileSync, existsSync } from "node:fs";
import { JsonRpcProvider, Network, Wallet } from "ethers";

const ENV = new URL("../.env", import.meta.url).pathname;
export function env() {
  const out = {};
  if (existsSync(ENV)) for (const line of readFileSync(ENV, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const CHAIN_ID = 31;
export const EXPLORER = "https://explorer.testnet.rootstock.io";
export const txLink = (h) => `${EXPLORER}/tx/${h}`;
export const addressLink = (a) => `${EXPLORER}/address/${a}`;

export function makeProvider(rpc) {
  return new JsonRpcProvider(rpc || "https://public-node.testnet.rsk.co", undefined, {
    staticNetwork: Network.from(CHAIN_ID),
  });
}

/** Wallet with a legacy-tx override — every ethers send goes out as type 0 with a bumped
 *  gasPrice sourced from the node, so we never build an EIP-1559 envelope RSK rejects.
 *  A 20% bump over the reported price is enough to clear the mempool without overpaying;
 *  RSK "minGasPrice" moves slowly, so this is stable across sessions. */
export async function makeSigner(pk, provider) {
  const w = new Wallet(pk, provider);
  const fee = await provider.getFeeData();
  const gasPrice = ((fee.gasPrice ?? 65000000n) * 12n) / 10n;
  const orig = w.sendTransaction.bind(w);
  w.sendTransaction = (tx) => orig({ ...tx, type: 0, gasPrice, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined });
  return w;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function withRetry(label, fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const m = (e?.error?.message || e?.shortMessage || e?.message || "").toLowerCase();
      if (!/rate|-32011|timeout|coalesce|failed to detect network|nonce/.test(m)) throw e;
      last = e;
      console.log(`  (${label}) retry ${i + 1}/${tries}…`);
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}
