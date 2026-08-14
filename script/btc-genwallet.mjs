// Generate a Bitcoin TESTNET (testnet3) wallet — for a one-shot OP_RETURN anchor of
// Predge's daily verdict merkle root. Writes .env.btc (mode 0600); prints only the public
// address so a screencast never leaks the key. Segwit v0 (P2WPKH, bech32 "tb1…") because
// modern faucets prefer it and fees are lower.
//
// Uses @noble/secp256k1 for the pure-JS ECC (no native compile), + bitcoinjs-lib for the
// address encoding. Deterministic RNG per-run (32 fresh bytes from node:crypto).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@noble/secp256k1";

const ENV = new URL("../.env.btc", import.meta.url).pathname;

if (existsSync(ENV) && /^BTC_PRIVKEY=[0-9a-fA-F]{64}$/m.test(readFileSync(ENV, "utf8"))) {
  console.error(".env.btc already has BTC_PRIVKEY — refusing to overwrite. Delete to rotate.");
  process.exit(1);
}

// 32 random bytes = raw secp256k1 private key
const priv = Buffer.from(crypto.randomBytes(32));
// Compressed public key (33 bytes)
const pub = Buffer.from(ecc.getPublicKey(priv, true));
// P2WPKH (segwit v0) testnet address — "tb1…"
const { address } = bitcoin.payments.p2wpkh({
  pubkey: pub,
  network: bitcoin.networks.testnet,
});

const body = [
  "# Bitcoin TESTNET (testnet3) — one-shot key for Predge OP_RETURN anchor",
  "# Fund at https://bitcoinfaucet.uo1.net/  or  https://coinfaucet.eu/en/btc-testnet/",
  "# Only tiny amounts (~0.0001 tBTC) needed; do NOT reuse for anything else.",
  `BTC_NETWORK=testnet`,
  `BTC_PRIVKEY=${priv.toString("hex")}`,
  `BTC_PUBKEY=${pub.toString("hex")}`,
  `BTC_ADDRESS=${address}`,
  "",
].join("\n");
writeFileSync(ENV, body, { mode: 0o600 });
console.log("wrote .env.btc (0600)");
console.log("BTC testnet address:", address);
console.log("");
console.log("fund it with a tiny amount (0.0001 tBTC is plenty) at:");
console.log("  https://bitcoinfaucet.uo1.net/  (fastest, no captcha)");
console.log("  https://coinfaucet.eu/en/btc-testnet/  (backup)");
