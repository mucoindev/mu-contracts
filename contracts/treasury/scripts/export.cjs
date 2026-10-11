const fs=require('fs');
const path=require('path');
const hre=require('hardhat');
async function main(){
  const a=await hre.artifacts.readArtifact('MuTreasury');
  const info=await hre.artifacts.getBuildInfo(`${a.sourceName}:MuTreasury`);
  const immutableRanges=Object.values(info.output.contracts[a.sourceName].MuTreasury.evm.deployedBytecode.immutableReferences||{}).flat();
  fs.writeFileSync(path.resolve(__dirname,'../../../release/treasury/abi.json'),JSON.stringify(a.abi)+'\n');
  fs.writeFileSync(path.resolve(__dirname,'../../../release/treasury/artifact.json'),JSON.stringify({abi:a.abi,bytecode:a.bytecode,runtime:a.deployedBytecode,immutableRanges})+'\n');
  console.log('MuTreasury runtime bytes:',(a.deployedBytecode.length-2)/2);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
