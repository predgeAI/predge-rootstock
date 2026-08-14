// Generate a fresh Rootstock testnet operator key. Writes .env (never committed);
// stdout only shows the public address so a log/screenshare never leaks the key.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Wallet } from "ethers";
const ENV = new URL("../.env", import.meta.url).pathname;

if (existsSync(ENV) && /^PRIVATE_KEY=0x[0-9a-fA-F]{64}$/m.test(readFileSync(ENV, "utf8"))) {
  console.error(".env already has PRIVATE_KEY — refusing to overwrite. Delete it manually to rotate.");
  process.exit(1);
}
const w = Wallet.createRandom();
const body = [
  "# Rootstock TESTNET · chainId 31 · tRBTC (fund at https://faucet.rootstock.io)",
  "ROOTSTOCK_RPC=https://public-node.testnet.rsk.co",
  "ROOTSTOCK_CHAINID=31",
  "ROOTSTOCK_EXPLORER=https://explorer.testnet.rootstock.io",
  `PRIVATE_KEY=${w.privateKey}`,
  `DEPLOYER_ADDRESS=${w.address}`,
  "",
].join("\n");
writeFileSync(ENV, body, { mode: 0o600 });
console.log("wrote .env (0600)");
console.log("deployer:", w.address);
console.log("fund at: https://faucet.rootstock.io  (~0.005 tRBTC = plenty for the demo)");
