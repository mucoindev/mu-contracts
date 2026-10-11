// Exports the compiled contracts for the web app and the Worker:
//
//   release/otc/MuOTC.json     = { contractName, abi, bytecode, deployedBytecode,
//                              deployedBytecodeHash, compiler, defaults }
//   release/otc/SimpleOTC.json = { address, abi }   (the legacy contract, read-only use)
//
//   npx hardhat run scripts/export-muotc.cjs      (or: npm run export)
//
// The OTC admin panel deploys MuOTC from Jon's wallet with `bytecode` + the
// constructor args in `defaults`. The Worker verifies a deployment with
// keccak256(eth_getCode(address)) == deployedBytecodeHash. That works because
// MuOTC has no immutables: the runtime code is not patched at deploy time, so it
// is identical for any constructor arguments (asserted below and in the tests).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const SRC_OTC = path.resolve(__dirname, "..", "..", "..", "release", "otc");

// Mainnet constructor arguments (Avalanche C-Chain 43114).
const DEFAULTS = {
  feeToken: "0xF7ed17f0Fb2B7C9D3DDBc9F0679b2e1098993e81", // MUG (18 decimals)
  feeAmount: "1000000000000000000", // 1 MUG, same as the legacy SimpleOTC
  feeRecipient: "0x12127E06c0A2C82368BFC9C5a05E86B24429838a", // MuRewards, same as legacy (see README)
};

const LEGACY_ADDRESS = "0xC4bdf802a9b77e8e09a136d55d6A14B66e94aF10";

async function main() {
  await hre.run("compile", { quiet: true });

  const fq = "contracts/MuOTC.sol:MuOTC";
  const artifact = await hre.artifacts.readArtifact(fq);
  const buildInfo = await hre.artifacts.getBuildInfo(fq);
  if (!buildInfo) throw new Error("no build info for MuOTC");

  const out = buildInfo.output.contracts["contracts/MuOTC.sol"].MuOTC;
  const immutables = out.evm.deployedBytecode.immutableReferences || {};
  if (Object.keys(immutables).length) {
    throw new Error("MuOTC must not use immutables (runtime code would depend on constructor args)");
  }
  if (artifact.deployedLinkReferences && Object.keys(artifact.deployedLinkReferences).length) {
    throw new Error("MuOTC must not need library linking");
  }

  const settings = buildInfo.input.settings;
  const muotc = {
    contractName: artifact.contractName,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
    deployedBytecodeHash: hre.ethers.keccak256(artifact.deployedBytecode),
    compiler: {
      version: buildInfo.solcLongVersion,
      optimizer: Boolean(settings.optimizer && settings.optimizer.enabled),
      runs: settings.optimizer ? settings.optimizer.runs : 0,
      evmVersion: settings.evmVersion,
    },
    defaults: DEFAULTS,
  };

  // Belt and braces: two local deployments with different args must have identical code.
  const F = await hre.ethers.getContractFactory("MuOTC");
  const [deployer, other] = await hre.ethers.getSigners();
  const Mock = await hre.ethers.getContractFactory("MockERC20");
  const mock = await Mock.deploy("Fee", "FEE");
  const a = await F.deploy(await mock.getAddress(), 1n, deployer.address);
  const b = await F.deploy(hre.ethers.ZeroAddress, 0n, other.address);
  for (const c of [a, b]) {
    const code = await hre.ethers.provider.getCode(await c.getAddress());
    if (hre.ethers.keccak256(code) !== muotc.deployedBytecodeHash) {
      throw new Error("deployed runtime code differs from the artifact");
    }
  }

  const legacy = await hre.artifacts.readArtifact("contracts/legacy/SimpleOTC.sol:SimpleOTC");
  const simple = { address: LEGACY_ADDRESS, abi: legacy.abi };

  fs.mkdirSync(SRC_OTC, { recursive: true });
  const muotcFile = path.join(SRC_OTC, "MuOTC.json");
  const simpleFile = path.join(SRC_OTC, "SimpleOTC.json");
  fs.writeFileSync(muotcFile, JSON.stringify(muotc, null, 2) + "\n");
  fs.writeFileSync(simpleFile, JSON.stringify(simple, null, 2) + "\n");

  console.log(`wrote ${muotcFile}`);
  console.log(`wrote ${simpleFile}`);
  console.log(`compiler ${muotc.compiler.version} optimizer=${muotc.compiler.optimizer} runs=${muotc.compiler.runs} evm=${muotc.compiler.evmVersion}`);
  console.log(`deployedBytecodeHash ${muotc.deployedBytecodeHash}`);
  console.log(`bytecode ${(artifact.bytecode.length - 2) / 2} bytes, runtime ${(artifact.deployedBytecode.length - 2) / 2} bytes`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
