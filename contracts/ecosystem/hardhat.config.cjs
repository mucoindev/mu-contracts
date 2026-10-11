require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
// Wallet deployments only. No live network or private key configuration.
module.exports = { solidity: { version: '0.8.28', settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' } }, mocha: { timeout: 60000 } };
