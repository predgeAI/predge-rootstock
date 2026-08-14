// VerdictAnchor constructor: (address anchorer_)
import { compileAndDeploy } from "./_compile.mjs";
import { env } from "../lib/rsk.mjs";
const e = env();
const anchorer = e.ANCHORER_ADDRESS || e.DEPLOYER_ADDRESS;
await compileAndDeploy({
  sourcePath: new URL("../contracts/VerdictAnchor.sol", import.meta.url).pathname,
  contractName: "VerdictAnchor",
  args: [anchorer],
  outFile: "VerdictAnchor.json",
});
