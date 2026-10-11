require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("hardhat-gas-reporter");

// No networks on purpose: MuOTC is deployed by Jon from his own wallet through
// the OTC admin panel on new.mu.money, using the bytecode exported to
// release/otc/MuOTC.json (scripts/export-muotc.cjs). Nothing here holds a key.
//
// The settings below are part of the deployed bytecode hash the Worker checks.
// Changing any of them (or any byte of a .sol file) changes the hash, so
// re-export release/otc/MuOTC.json after every change.
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
  },
  networks: {
    hardhat: {},
  },
  gasReporter: {
    enabled: false, // `npm run test:gas` turns it on (hardhat.gas.config.cjs)
    offline: true,
    currency: "USD",
  },
  mocha: { timeout: 60000 },
};
