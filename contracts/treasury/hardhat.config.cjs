require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
// Wallet deployments only. No live network or private key configuration.
module.exports = { solidity: { version: '0.8.28', settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai' } }, networks: { hardhat: { hardfork: 'shanghai', ...(process.env.RUN_TREASURY_FORK==='1'?{accounts:[]}: {}) } }, mocha: { timeout: 60000 } };
