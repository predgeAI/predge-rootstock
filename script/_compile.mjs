// One compile-and-deploy helper reused by every deploy script — same solc settings and
// legacy-tx signer for all four contracts.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import solc from "solc";
import { ContractFactory } from "ethers";
import { env, makeProvider, makeSigner, withRetry, addressLink, txLink } from "../lib/rsk.mjs";

export async function compileAndDeploy({ sourcePath, contractName, args = [], outFile }) {
  const source = readFileSync(sourcePath, "utf8");
  const input = {
    language: "Solidity",
    sources: { [`${contractName}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun", // Rootstock Lovell (Feb 2024) shipped PUSH0/MCOPY/TLOAD/TSTORE/BASEFEE
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (out.errors || []).filter((e) => e.severity === "error");
  if (fatal.length) {
    console.error("Solc errors:\n" + fatal.map((e) => e.formattedMessage).join("\n"));
    process.exit(1);
  }
  const c = out.contracts[`${contractName}.sol`][contractName];
  console.log(`Compiled ${contractName} (solc ${solc.version()}, evmVersion cancun).`);

  const e = env();
  if (!e.PRIVATE_KEY) { console.error("No PRIVATE_KEY in .env — run `npm run genwallet`."); process.exit(1); }
  const provider = makeProvider(e.ROOTSTOCK_RPC);
  const wallet = await makeSigner(e.PRIVATE_KEY, provider);
  const bal = await withRetry("getBalance", () => provider.getBalance(wallet.address));
  console.log("Deployer:", wallet.address, "| tRBTC:", bal.toString());
  if (bal === 0n) {
    console.error("Balance is 0. Fund at https://faucet.rootstock.io and re-run.");
    process.exit(1);
  }

  const factory = new ContractFactory(c.abi, "0x" + c.evm.bytecode.object, wallet);
  const contract = await withRetry("deploy", () => factory.deploy(...args));
  const deployTx = contract.deploymentTransaction();
  await withRetry("waitForDeployment", () => contract.waitForDeployment());
  const addr = await contract.getAddress();
  console.log(`\n${contractName} deployed at: ${addr}`);
  console.log("  " + addressLink(addr));
  console.log("  deploy tx: " + txLink(deployTx.hash));

  const DEPLOY_DIR = new URL("../deploy/", import.meta.url).pathname;
  if (!existsSync(DEPLOY_DIR)) mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(
    DEPLOY_DIR + outFile,
    JSON.stringify(
      { address: addr, deployer: wallet.address, chainId: 31, deployTx: deployTx.hash, deployedAt: new Date().toISOString(), args: args.map((a) => (typeof a === "bigint" ? a.toString() : a)) },
      null,
      2,
    ) + "\n",
  );
  console.log(`Wrote deploy/${outFile}`);
  return { address: addr, abi: c.abi, wallet, provider };
}
