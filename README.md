# MU contracts

Public smart-contract source for the MU ecosystem on Avalanche C-Chain (43114).
This repository builds and tests independently. It contains no website, frontend,
Worker, database, application credentials, or application Git history.

| Directory | Purpose |
| --- | --- |
| `contracts/dogy` | Dogy NFT and demo voucher contracts |
| `contracts/otc` | OTC contracts and legacy compatibility tests |
| `contracts/casino` | Casino accounting and VRF contracts |
| `contracts/ecosystem` | Token, vesting, subscription and governance templates |
| `contracts/treasury` | Treasury inventory and liquidity contracts |
| `contracts/world` | TRAIL market contracts |
| `contracts/protocol` | Upgradeable protocol candidates; not activated by publishing |
| `legacy/verified-src` | Archived verified-source references, including existing tokens |
| `release` | Versioned ABI, bytecode, runtime-verification data and source exports |

Use Node 22. Each maintained package has its own lockfile:

```sh
cd contracts/otc
npm ci --ignore-scripts --no-audit --no-fund
npx hardhat test
npm run export
```

Export scripts write only to this repository's `release/` directory. Application
consumers copy a reviewed release and pin its full Git commit and file SHA-256
hashes. A contract release never deploys the app or changes deployed contracts.
Do not regenerate historical bytecode just to move repositories: exact runtime
hashes identify existing deployments. The casino package documents its preserved
historical artifact and tests executable parity with a fresh compiler build.

After deliberately updating exports, run `npm run release:prepare`, review the
diff, commit, and run `npm run ship`. CI tests all seven packages independently,
checks the release manifest and retains compiler evidence. Publishing runs no
chain transactions. Production deployments and upgrades require wallet signing.

The legacy archive preserves source text and addresses recorded in filenames;
it is not a list of approved or currently active deployments. See its index.

New project code is MIT licensed; individual source SPDX notices and bundled
third-party notices take precedence. See LICENSE and legacy/README.md.
