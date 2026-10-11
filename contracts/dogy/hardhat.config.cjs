require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("hardhat-gas-reporter");

// Only Fuji (testnet) is configured on purpose. There is no mainnet network
// here: a mainnet deploy needs Jon's decisions in README.md first.
const fujiKey = process.env.FUJI_PRIVATE_KEY;

const settings = {
  optimizer: { enabled: true, runs: 200 },
  // OpenZeppelin 5.6 uses MCOPY, so Cancun is required. Avalanche C-Chain
  // activated the Cancun opcodes in the Etna upgrade (ACP-131, Dec 2024).
  evmVersion: "cancun",
};

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    compilers: [{ version: "0.8.28", settings }],
    // MuDogyTest is pinned to 0.8.24 (requested). Its deployed bytecode hash is
    // what the Worker verifies, so do not change these settings casually: any
    // change produces a different hash (re-export release/dogy/MuDogyTest.json).
    overrides: { "contracts/MuDogyTest.sol": { version: "0.8.24", settings } },
  },
  networks: {
    hardhat: {},
    fuji: {
      url: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts: fujiKey ? [fujiKey] : [],
    },
  },
  gasReporter: {
    enabled: false, // `npm run test:gas` turns it on (hardhat.gas.config.cjs)
    offline: true,
    currency: "USD",
  },
  mocha: { timeout: 60000 },
};
