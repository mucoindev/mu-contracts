# MuPortfolio

`MuPortfolio.sol` is an immutable vault for individually accounted investment
cards. Deployment fixes USDC, MU Gold, its fee recipient, LFJ's LB router,
LFJ's V1 liquidity router/factory, one aggregation router and up to six supported
assets. The first asset is the wrapped native token. The UI integration on
Avalanche uses WAVAX, BTC.b, MU, MUG, USDt and USDC.e.

`open` accepts a funding token and exact quantity (zero address means native
AVAX), a fixed USDC basket budget, one to four distinct asset legs, a fee swap,
optional two-asset liquidity and minimum outputs. Native funds are wrapped,
non-USDC funds are swapped to USDC, and the fixed basket budget plus its 0.10%
fee are spent. Better funding execution remains as a USDC reserve on the card.
All operations revert together if a minimum, path, spend amount or liquidity
condition fails. Trading fees and gas are additional economic costs.

Only the opening wallet can close its card. `cashOut` removes LP, swaps actual
received quantities through LFJ, and sends all resulting USDC plus the reserve
to that owner. `withdrawInKind` directly transfers held tokens, LP and reserve
to the owner without depending on a router. Both keep historical
purchase records; in-kind withdrawal records quantities rather than inventing
a realized dollar result. Each full-card exit can happen only once.

`ownerPositionCount`, `ownerPositionId` and `getPosition` expose paginated history.
The struct retains costs, funding quantity and value, fees, timestamps, block
numbers, original and remaining quantities, LP and exit results. Records are
public. No backend or local storage is needed to establish ownership or amounts.

Caller-provided aggregation calldata goes only to the immutable aggregator,
receives an exact temporary input allowance, must spend exactly that input and
must return at least the required output to the vault. Approvals clear after each
call. A reentrancy guard covers every state-changing position action. Deployment
must use reviewed token/router addresses; test constructors deliberately accept
mocks. The vault has no owner, upgrade mechanism or arbitrary recovery function.

Test and export from this package:

```
npx hardhat test
npx hardhat run scripts/export-portfolio.cjs
```

Set `RUN_PORTFOLIO_FORK=1` and run `npx hardhat test test/portfolio-fork.cjs`
for the explicit local Avalanche fork integration. The fork is configured at
startup under Cancun (current DEX executors use Cancun opcodes). EDR 2.28 has
a reset/storage-override issue, so this test does not call `hardhat_reset`.
It uses locally impersonated accounts and sends no live transactions.
