require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@openzeppelin/hardhat-upgrades');
module.exports = {
  solidity: { version: '0.8.28', settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['storageLayout'] } },
  } },
  // Deliberately no live networks or private keys: deployment is wallet-signed.
  networks: { hardhat: {} },
  mocha: { timeout: 60000 },
};
