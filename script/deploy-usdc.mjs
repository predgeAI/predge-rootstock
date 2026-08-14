import { compileAndDeploy } from "./_compile.mjs";
await compileAndDeploy({
  sourcePath: new URL("../contracts/MockUSDC.sol", import.meta.url).pathname,
  contractName: "MockUSDC",
  outFile: "MockUSDC.json",
});
