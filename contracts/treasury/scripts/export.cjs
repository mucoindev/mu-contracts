const fs=require('fs');
const path=require('path');
const hre=require('hardhat');
async function main(){
  for(const name of ['MuTreasury','LiveMuTreasury']) {
  const a=await hre.artifacts.readArtifact(name);
  const prefix=name==='LiveMuTreasury'?'live-':'';
  const info=await hre.artifacts.getBuildInfo(`${a.sourceName}:${name}`);
  const immutableRanges=Object.values(info.output.contracts[a.sourceName][name].evm.deployedBytecode.immutableReferences||{}).flat();
  fs.writeFileSync(path.resolve(__dirname,`../../../release/treasury/${prefix}abi.json`),JSON.stringify(a.abi)+'\n');
  fs.writeFileSync(path.resolve(__dirname,`../../../release/treasury/${prefix}artifact.json`),JSON.stringify({abi:a.abi,bytecode:a.bytecode,runtime:a.deployedBytecode,immutableRanges})+'\n');
  console.log(name+' runtime bytes:',(a.deployedBytecode.length-2)/2);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
