require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
// Wallet deployments only. No live network or private key configuration.
module.exports = { solidity: { version: '0.8.28', settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai' } }, networks: { hardhat: { hardfork: process.env.RUN_PORTFOLIO_FORK==='1'?'cancun':'shanghai', ...(process.env.RUN_PORTFOLIO_FORK==='1'?{forking:{url:'https://api.avax.network/ext/bc/C/rpc'}}:{}), ...((process.env.RUN_TREASURY_FORK==='1'||process.env.RUN_PORTFOLIO_FORK==='1')?{accounts:[]}: {}) } }, mocha: { timeout: 60000 } };
