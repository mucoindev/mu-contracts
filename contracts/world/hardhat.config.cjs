require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
module.exports = {
  solidity: { version: '0.8.28', settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' } },
  networks: { hardhat: {} },
  mocha: { timeout: 60000 },
};
