// Compile-only candidate bundle. This script never deploys or signs anything.
const { artifacts, ethers, upgrades } = require('hardhat');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
async function main() {
  const name = 'contracts/MuDogyUpgradeable.sol:MuDogyUpgradeable';
  await upgrades.validateImplementation(await ethers.getContractFactory(name), { kind: 'uups' });
  const artifact = await artifacts.readArtifact(name);
  const info = await artifacts.getBuildInfo(name);
  const output = info.output.contracts['contracts/MuDogyUpgradeable.sol'].MuDogyUpgradeable;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  const lockSha256 = createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
  const bundle = {
    schemaVersion: 1, contract: 'MuDogyUpgradeable', status: 'candidate-not-deployed',
    commit, dirty, lockSha256, proxyKind: 'uups', compiler: info.solcLongVersion,
    settings: info.input.settings, abi: artifact.abi, bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
    // UUPS __self is patched at deployment. A raw template hash is NOT an
    // implementation identity check; verification must use these ranges and
    // independently check the actual implementation address / proxiableUUID.
    immutableReferences: output.evm.deployedBytecode.immutableReferences,
    storageLayout: output.storageLayout,
    activationBlockers: ['upgrade-authority', 'randomness-review', 'proxy-aware-registration', 'wallet-integration', 'fuji-qualification', 'security-review'],
  };
  mkdirSync('release', { recursive: true });
  writeFileSync('release/MuDogyUpgradeable.json', JSON.stringify(bundle, null, 2) + '\n');
  writeFileSync('release/build-info.json', JSON.stringify(info, null, 2) + '\n');
  console.log(`Candidate exported from ${commit}${dirty ? ' (dirty development tree; not releasable)' : ''}; no transactions sent.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
