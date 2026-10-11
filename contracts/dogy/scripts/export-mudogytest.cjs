// Writes the compiled MuDogyTest artifact for the web page (which deploys it from
// MetaMask) and the Worker (which verifies a deployment by bytecode hash):
//   release/dogy/MuDogyTest.json = { abi, bytecode, deployedBytecodeHash }
//
//   npx hardhat run scripts/export-mudogytest.cjs
//
// Verify a deployment: keccak256(eth_getCode(address)) == deployedBytecodeHash.
// This holds because MuDogyTest has no immutables (runtime code is not patched
// at deploy time).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  await hre.run("compile", { quiet: true });
  const artifact = await hre.artifacts.readArtifact("MuDogyTest");
  if (artifact.deployedLinkReferences && Object.keys(artifact.deployedLinkReferences).length) {
    throw new Error("MuDogyTest must not need library linking");
  }
  const out = {
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecodeHash: hre.ethers.keccak256(artifact.deployedBytecode),
  };
  const file = path.resolve(__dirname, "..", "..", "..", "release", "dogy", "MuDogyTest.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}`);
  console.log(`deployedBytecodeHash ${out.deployedBytecodeHash}`);
  console.log(`bytecode ${(artifact.bytecode.length - 2) / 2} bytes, runtime ${(artifact.deployedBytecode.length - 2) / 2} bytes`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
