const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
async function main() {
  const result = {};
  for (const name of ['MuFixedToken','MuVesting','MuSubscription','MuGovernor','MuTimelock']) {
    const a = await hre.artifacts.readArtifact(name);
    const info = await hre.artifacts.getBuildInfo(`${a.sourceName}:${name}`);
    const immutableRanges = Object.values(info.output.contracts[a.sourceName][name].evm.deployedBytecode.immutableReferences || {}).flat();
    result[name] = { abi: a.abi, bytecode: a.bytecode, runtime: a.deployedBytecode, immutableRanges };
    console.log(name, 'runtime', (a.deployedBytecode.length-2)/2, 'init', (a.bytecode.length-2)/2);
  }
  fs.writeFileSync(path.resolve(__dirname,'../../../release/ecosystem/artifacts.json'),JSON.stringify(result)+'\n');
}
main().catch(e=>{ console.error(e); process.exitCode=1; });
