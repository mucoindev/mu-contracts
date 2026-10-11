const { artifacts, ethers } = require('hardhat');
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const artifact = await artifacts.readArtifact('TrailMarket');
  const output = { contractName: artifact.contractName, compiler: '0.8.28', abi: artifact.abi, bytecode: artifact.bytecode,
    deployedBytecodeHash: ethers.keccak256(artifact.deployedBytecode) };
  fs.writeFileSync(path.join(__dirname, '../../../release/world/TrailMarket.json'), JSON.stringify(output, null, 2) + '\n');
  fs.writeFileSync(path.join(__dirname, '../../../release/world/TrailMarketAbi.json'), JSON.stringify(artifact.abi, null, 2) + '\n');
  console.log(`Exported TrailMarket (${(artifact.deployedBytecode.length - 2) / 2} runtime bytes), ${output.deployedBytecodeHash}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
