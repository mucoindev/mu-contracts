# MU contracts 1.2.0

Adds MuPortfolio: immutable wallet-owned investment positions, atomic multi-asset
funding and basket purchases, a fixed 10-basis-point fee converted to MU Gold,
optional LFJ V1 liquidity, and owner-only cash-out or in-kind withdrawals.

Positions retain original funding quantity, USDC conversion value, individual
purchase costs and received quantities, exact fee, timestamps and block numbers.
Conversion surplus remains assigned to its original position. No administrator
can withdraw positions, change fees or upgrade this vault.

The vault permits typed LFJ swaps and one immutable aggregation router with
exact-input, minimum-output checks and temporary exact allowances. Source release
and application publication do not deploy the vault or move assets on Avalanche.

Validation includes isolated accounting, access control, complete rollback,
input/output constraints, wrong-router/recipient rejection, liquidity and exit
tests, export parity and an explicit local Avalanche fork integration test.
The fork test needs RUN_PORTFOLIO_FORK=1, uses a local Cancun EVM, and never
signs or broadcasts a transaction to Avalanche. Automated tests are not an
independent security audit.

All previous deployment artifacts remain unchanged. New exports are
portfolio/abi.json and portfolio/artifact.json.
