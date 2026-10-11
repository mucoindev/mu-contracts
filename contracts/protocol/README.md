# MU upgradeable protocol candidates

`MuDogyUpgradeable` is a UUPS port of the production Dogy birth/reroll engine,
not the demo voucher contract. It starts paused and retains the existing paid
birth/reroll rules, block-derived randomness limitations and ERC-721 behavior.
It is **not deployed, audited, integrated or approved for paid activation**.

Authority and ecosystem migration definitions: [repository guide](../../README.md).
The owner can upgrade all logic while paused. A multisig/timelock is the proposed
production owner; no controller address has been chosen by this package.

From this directory, on Jon's workstation:

```powershell
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm ci --ignore-scripts --no-audit --no-fund
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm test
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm run release
```

GitHub Actions runs these commands on hosted runners without the workstation
governor. The package has no configured live chain or signer. Release exports
are compile-only candidates with source commit, dirty flag, lockfile hash,
compiler settings/input, ABI, bytecode, immutable references and storage layout.
They are not deployment manifests or proof of a successful on-chain release.
The test-only successor and timelock live under `contracts/test`; never ship them.

OZ libraries are pinned to 5.6.1, Upgrades to Hardhat-2-compatible 3.9.1,
Hardhat to 2.28.0 and Solidity to 0.8.28/Cancun. The Dogy business storage is
append-only; OZ parents use namespaced storage. Preserve both across upgrades.
