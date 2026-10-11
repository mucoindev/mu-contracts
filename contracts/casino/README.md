# MU casino contracts

MuCasino is a non-upgradeable MUG escrow with coin flip, high/low dice and a daily ticket draw. Runtime configuration is storage with no setters so the Worker can compare the exact compiler runtime hash, then verify token, recipient, owner, coordinator, key hash, subscription and paused state. Wallet deployment only; Hardhat has no mainnet network or private key.

The app's existing exported artifact is preserved for the registered casino.
Fresh LF-normalized source compiles to the same executable code but a different
Solidity metadata IPFS digest. CI deploys the exported artifact locally and checks
its full runtime hash, then compares it with the fresh build allowing only that
32-byte digest in the exact solc 0.8.28 metadata trailer to differ. Worker runtime
verification still requires the full exported hash; it does not strip metadata.
Do not overwrite historical deployment artifacts merely to normalize metadata.

## Accounting

All balances are MUG wei; the UI displays 100 credits per MUG. Deposits and redemptions are 1:1 underlying token movements. There are no browser-authorized payouts, operator settlement signatures or tradable credit tokens.

`liabilities = totalCredits + reservedPayouts + lotteryPots`

`availableProfit = max(0, MUG balance - liabilities - bankrollPrincipal)`

Quick bets debit the stake and reserve the entire 1.96x payout before requesting randomness. The full lottery sales pot stays reserved until settlement; the winner gets 90%. Bankroll losses must be recouped before profit can be distributed. Owner withdrawals are capped by both original bankroll principal and unreserved token balance; no player funds can be withdrawn by the owner. Bankroll is risk capital, with no guaranteed recovery. Direct token donations above protected balances count as surplus.

Each wallet can have one pending quick bet. The latest request stays on-chain so reloads or clearing browser storage do not lose the bet. Minimum stake 1 credit; maximum 10,000; each ticket 10 credits. Each lottery has at most 4,096 purchase entries, with 1–1,000 tickets per purchase; binary search chooses the winning range. Round fee and duration are fixed in bytecode. This is not a DAO-controlled contract.

## Randomness and settlement

Chainlink VRF v2.5 native AVAX billing, 10 confirmations, callback gas 150,000, one word per request. Callback authenticates coordinator and only records the first seed. Settlement is a separate permissionless call, crediting the winner internally. There are no rerolls, cancellations or timeout refunds that could select favorable outcomes. Pausing stops deposits, new bets, ticket purchases and opening rounds; existing cash-outs, randomness requests for closed rounds and settlement remain available.

Delayed/unfunded oracle requests can leave stakes pending indefinitely. Subscription owner can remove the consumer or cancel funding; this is an operational trust dependency. Maintain AVAX funding and consumer registration. The 200 gwei lane caps oracle gas price. The house pays oracle costs separately from MUG credits; the 2% theoretical game edge excludes those costs. Very small bets may cost more in VRF fees than they earn. Modulo selection has negligible, nonzero bias (at most the ticket range divided by 2^256); it is not a source of practically exploitable advantage.

## Deployment and review

The implementation is locally tested, not independently audited or testnet-qualified. Before player funds: independent contract/security review, Fuji end-to-end VRF deployment and fulfillment tests, mainnet read-only configuration check, operating/launch requirements, and oracle cost/bankroll sizing. This release never deploys a paid casino automatically.

The live `/admin/casino` page lets Jon deploy paused, register a verified receipt, add the consumer through Chainlink, fund bankroll and activate. No private keys in this repository. Registration is first-write only to prevent switching players to an empty replacement ledger. The existing MuRewards recipient is fixed; see `docs/casino/LAUNCH.md` for its inherited override behavior.

Run via machine governor in this directory:

```
node C:/projects/.agent-bridge/guard.mjs run --kind build -- npm ci --ignore-scripts --no-audit --no-fund
node C:/projects/.agent-bridge/guard.mjs run --kind build -- npm test
node C:/projects/.agent-bridge/guard.mjs run --kind build -- npm run export
```

Any Solidity or compiler setting edit requires re-exporting `release/casino/MuCasino.json`. Tests cover reserve accounting, wallet redemption while paused, owner capital limits, unauthorized callbacks, duplicate fulfillment, replay, out-of-order fulfillment, lottery deadlines/ranges, empty rounds and mixed-game solvency. They do not constitute an audit.

Sources checked October 11, 2026: [network configuration](https://docs.chain.link/vrf/v2-5/supported-networks), [VRF security guidance](https://docs.chain.link/vrf/v2-5/security), [official ABI](https://github.com/smartcontractkit/chainlink-brownie-contracts/blob/main/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol).
