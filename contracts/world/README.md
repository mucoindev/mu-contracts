# Trail Coins / MUG market

This package implements the **official TRAIL/MUG constant-product pool** and a
separate game-token custody bucket. TRAIL is a conventional transferable ERC-20;
the contract restricts its own pool to MUG, not markets other people may create.
It is new code with automated tests, not an independently audited deployment.

## Economic behavior

- 10,000,000 TRAIL, 18 decimals, minted once to the deploying wallet. No later
  minting or administrator withdrawal function exists.
- The first liquidity contribution uses 100 TRAIL per 1 MUG. Subsequent trades
  change the reserve ratio and execution price. This is **not** a fixed redemption
  promise. Larger trades incur greater price impact.
- Buys send 1% of input MUG to Rewards and add the remaining 99% to the pool.
  Sells deduct 1% of gross MUG output for Rewards. Fees round up to one MUG wei;
  zero-output trades revert. LPs hold principal and market exposure, with no LP
  trading-fee allocation in this version.
- The latest LP-market design supersedes sending all purchase principal to
  Rewards: liquidity needs that principal to support sales. Only trading fees
  go to Rewards. Never describe the entire purchase as a Rewards payment.
- LP accounting is proportional and nontransferable. The first 1,000 minimum
  shares are permanently locked. Anyone can add liquidity; only their own
  shares can be withdrawn. Adds/removals have minimum amounts and deadlines.
- Direct token donations are not reserves or game backing and cannot be swept.
  Use the named funding functions. A small permanently locked reserve remains
  after all redeemable LP shares leave.

## Deployment and operation

Deploy `TrailMarket(mug, rewards, gameSigner)` from the intended owner wallet,
through the protected admin UI. There is no mainnet deploy script here.

Avalanche C-Chain (43114) configuration:

| Parameter | Address |
|---|---|
| MUG | `0xF7ed17f0Fb2B7C9D3DDBc9F0679b2e1098993e81` |
| Rewards | `0x12127E06c0A2C82368BFC9C5a05E86B24429838a` |
| Intended deploying / owner wallet | `0xF243d79910cBd70a0eaF405b08E80065a67D5e14` |
| Game signer | Configured server signer public address; never expose its key |

Deployment starts paused. Verify runtime hash and constructor state, register
the address with the game server, add MUG/TRAIL liquidity, fund the game reward
budget, and only then enable trading. Funding amounts require the wallet's
explicit transaction approval. No deployment or funding is performed by tests.
MUG and Rewards addresses are stored once and have no setters. The owner can
pause trades/new game deposits, rotate the game signer, or transfer ownership.
LP removal and authorized game withdrawals remain available while paused.

Both MUG and TRAIL spending require ERC-20 allowance to the market address.
For TRAIL, token address and spender are the same deployed contract. The
allowance is consumed by sell, add-liquidity, game-deposit and reward-funding
operations. Quotes are previews only: clients must set minimum output and a
short deadline on the transaction they ask the wallet to sign.

## Game custody and server ledger

`fundGameRewards(amount)` and `depositGame(amount)` accept positive whole TRAIL
amounts (`amount % 10^18 == 0`) and increase `gameBacking`. They emit separate
`GameRewardsFunded(account, amount)` and `GameDeposit(account, amount)` events.
The server verifies confirmed receipts, contract/chain/event owner, and credits
each transaction log exactly once. Funding establishes reward budget; player
deposits establish player balances. Raw `gameBacking` alone is not an
unallocated reward budget: it can include uncredited pending deposits.

`withdrawGame(account, amount, nonce, deadline, signature)` releases only that
bucket, never LP reserves or donated tokens. The same account must submit it.
Authorization is standard EIP-712:

```js
domain = { name: 'TrailMarket', version: '1', chainId: 43114, verifyingContract: market }
types = { Withdraw: [
  { name: 'account', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] }
```

The server reserves/debits a player's coins atomically before signing, persists
the voucher, and checks `usedNonces(account, nonce)` plus confirmed withdrawal
events before restoring an expired authorization. Never issue two outstanding
vouchers against the same ledger funds. The signature is chain/contract-bound;
nonces are single-use per account. Signer rotation revokes outstanding old-key
signatures, which the server must reconcile before replacing vouchers.

The signer is trusted to authorize the off-chain game ledger. A compromised
signer can drain the **game backing** through a controlled account but cannot
withdraw LP principal. Gameplay earnings must be backed by confirmed reward
funding and bounded server-side budgets. These contracts do not themselves
validate game challenges, individual player ledger balances, or game rewards.

## Verification

Use the machine governor for every build/test operation:

```powershell
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm test
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm run export
```

Run from `contracts/world`. Dependencies match the existing Dogy Hardhat stack;
the task worktree currently links the existing installed dependency directory.
On a fresh machine, install this package's pinned dependencies under the same
governor. Never delete a junction recursively; the repo task cleanup tool knows
how to unlink it safely.

Solidity 0.8.28, optimizer 200 runs, Cancun. `scripts/export.cjs` writes
`release/world/TrailMarket.json` (ABI, deployment bytecode, runtime hash) for protected
admin deployment and `release/world/TrailMarketAbi.json` (ABI only) for public market
interaction. There are no immutable runtime substitutions, so deployed runtime
code hashes identically across constructor arguments. `MockMug.sol` is a local
test fixture, not exported or deployed by the app.

The tests cover both trading directions, fees, changing price, quote limits,
round trips, LP proportions/ownership, deadlines, donations, bucket separation,
authorization/replay/domain checks, signer rotation, paused exits, unsupported
fee-on-transfer input, reentrancy, and mixed-operation solvency.
