const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
async function main() {
  const artifact = await hre.artifacts.readArtifact('MuPortfolio');
  const info = await hre.artifacts.getBuildInfo(`${artifact.sourceName}:MuPortfolio`);
  const immutableRanges = Object.values(info.output.contracts[artifact.sourceName].MuPortfolio.evm.deployedBytecode.immutableReferences || {}).flat();
  const dir = path.resolve(__dirname, '../../../release/portfolio');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abi.json'), JSON.stringify(artifact.abi) + '\n');
  fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode, runtime: artifact.deployedBytecode, immutableRanges }) + '\n');
  console.log('MuPortfolio runtime bytes:', (artifact.deployedBytecode.length - 2) / 2);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
