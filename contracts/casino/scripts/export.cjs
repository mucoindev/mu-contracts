const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
async function main() {
  const a = await hre.artifacts.readArtifact('MuCasino');
  const info = await hre.artifacts.getBuildInfo('contracts/MuCasino.sol:MuCasino');
  const refs = info.output.contracts['contracts/MuCasino.sol'].MuCasino.evm.deployedBytecode.immutableReferences || {};
  if (Object.keys(refs).length) throw new Error('Runtime verification requires no immutables');
  fs.writeFileSync(path.resolve(__dirname, '../../../release/casino/MuCasino.json'), JSON.stringify({
    contractName: a.contractName, abi: a.abi, bytecode: a.bytecode,
    deployedBytecodeHash: hre.ethers.keccak256(a.deployedBytecode), compiler: info.solcLongVersion,
  }, null, 2) + '\n');
  console.log('Exported MuCasino; runtime bytes:', (a.deployedBytecode.length - 2) / 2);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
