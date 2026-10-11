// Same as hardhat.config.cjs with the gas reporter on. Used by `npm run test:gas`.
const config = require("./hardhat.config.cjs");

module.exports = {
  ...config,
  gasReporter: { ...config.gasReporter, enabled: true, reportPureAndViewMethods: false },
};
