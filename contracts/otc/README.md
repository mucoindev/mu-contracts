# MuOTC: the OTC Counter contract

Peer-to-peer escrow trading of ERC-20 tokens and ERC-721 NFTs on Avalanche
C-Chain (43114). It replaces the legacy `SimpleOTC` at
`0xC4bdf802a9b77e8e09a136d55d6A14B66e94aF10`. **Not deployed yet.**

| File | What it is |
| --- | --- |
| `contracts/MuOTC.sol` | The contract (solc 0.8.28, OpenZeppelin 5.6.1). |
| `contracts/legacy/SimpleOTC.sol` | Reference copy of the live legacy contract, compiled only to export its ABI. Never deploy it. |
| `contracts/mocks/*` | Test tokens: 18- and 6-decimal ERC-20s, a fee-on-transfer ERC-20, ERC-721s (plain, hook-calling, broken) and a reentrancy attacker. |
| `test/MuOTC.test.cjs` | The MuOTC suite. |
| `test/SimpleOTC.legacy.test.cjs` | Smoke test of the legacy copy plus its exported ABI. |
| `scripts/export-muotc.cjs` | Writes `release/otc/MuOTC.json` and `release/otc/SimpleOTC.json` for the app and the Worker. |

## What changed from SimpleOTC

| SimpleOTC (legacy) | MuOTC |
| --- | --- |
| Maker creates, then deposits in a second transaction. | `createOrder` takes the fee and escrows the maker's asset in **one** transaction. |
| Taker deposits, then someone finalizes (2 more transactions). | `fillOrder` is **one atomic** transaction: the taker's asset goes straight to the maker and the escrow goes to the taker. A filler can never pay without receiving. |
| Fee-on-transfer tokens are credited at face value, so one order can drain another order's escrow of the same token. | Every ERC-20 move into escrow or to the maker is balance-checked; fee-on-transfer and rebasing tokens revert with `FeeOnTransferNotSupported`. |
| Only creators are indexed; pagination underflows when the offset is past the end. | Open-order set (O(1) swap-and-pop), maker index and taker index; every page call returns empty arrays instead of reverting. |
| Either party can cancel after depositing. | Only the maker can cancel; the taker never deposits, so there is nothing of theirs to refund. |

## Order lifecycle

```
                 createOrder (fee paid, give escrowed)
      (none) ───────────────────────────────────────────▶ Open
                                                          │  │
           fillOrder (anyone, or the reserved taker;      │  │  cancelOrder (maker only;
           not the maker; before expiresAt)               │  │  also after expiry; also when paused)
                                                          ▼  ▼
                                                    Filled    Cancelled
```

- `Status.None` means the id does not exist. Ids run `1..orderCount`.
- `taker == 0` is an open order; anyone but the maker can fill it and the filler
  is written into `taker`. A non-zero `taker` reserves the order for that wallet.
- `expiresAt == 0` never expires. Otherwise the order can be filled while
  `block.timestamp < expiresAt`. An expired order is still `Open` (and still in
  the open set) until its maker cancels it; the UI should filter on `expiresAt`.
- `closedAt` is set when the order is filled or cancelled.

### Wallet steps

Maker:
1. `feeToken.approve(MuOTC, feeAmount)` (skip when the fee is off).
2. Approve the `give` asset: ERC-20 `approve(MuOTC, amount)`, or ERC-721
   `approve(MuOTC, id)` / `setApprovalForAll(MuOTC, true)`. If `give` is the fee
   token itself (MUG), one approval of `feeAmount + amount` covers both.
3. `createOrder(taker, give, get, expiresAt)`: the order shows as deposited
   as soon as this confirms.

Filler:
1. Approve the order's `get` asset to MuOTC.
2. `fillOrder(id)`. `canFill(id, wallet)` tells the UI beforehand whether the
   order itself allows it ("not open", "expired", "maker cannot fill",
   "reserved for another wallet"); it does not check balances or approvals.

The contract only ever pulls assets from `msg.sender` (the maker in
`createOrder`, the filler in `fillOrder`), so an approval to MuOTC can never be
used by a third party.

Errors are custom errors (in the ABI). ethers v6 decodes them, for example
`err.revert.name === "FeeOnTransferNotSupported"`.

## Trust model

The owner (Ownable2Step; initial owner = deployer) has exactly two powers:

- `setFee(token, amount, recipient)`: the listing fee for **future** orders.
  `amount` is capped at `MAX_FEE = 100e18`, i.e. 100 tokens assuming an
  18-decimal fee token like MUG (with a 6-decimal fee token the cap would be
  100e12 whole tokens, so do not switch to one without revisiting this).
  `amount = 0` or `recipient = 0` turns the fee off.
- `setPaused(bool)`: blocks `createOrder` only. Fills and cancels always work,
  so a pause can never trap anyone's escrow.

There is no function that moves escrowed assets anywhere except to the filler
(on fill) or back to the maker (on cancel). No upgradeability, no proxy, no
`selfdestruct`, no `delegatecall`, no rescue or sweep function, nothing
payable. The test suite pins the exact function list. If the owner key is lost
or ownership is renounced, trading continues with the last fee settings.

Consequences of having no rescue function:

- Tokens sent to the contract directly with `transfer` are lost forever.
- NFTs pushed in with `safeTransferFrom` are **rejected** (`UnsolicitedERC721`):
  `onERC721Received` only accepts an NFT while one of MuOTC's own functions is
  running (the escrow pull in `createOrder`, for collections whose
  `transferFrom` calls the receiver hook).

### Where the fee goes (Jon: MU Rewards, 2026-10-11)

The default fee recipient is MuRewards `0x12127E06c0A2C82368BFC9C5a05E86B24429838a`,
the same as the legacy contract. Two public functions on MuRewards, callable by
**anyone**:

- `MU_REWARDS_PAYMENT(token)` pays the contract's whole balance of `token` out
  to MUO and MUV holders.
- `withdrawlOverride(token)` sends the contract's whole balance of `token` to
  `0xF243d79910cBd70a0eaF405b08E80065a67D5e14` (Jon's wallet).

So fee MUG that lands there goes to whichever of those someone calls first.
Jon confirmed on 2026-10-11 that OTC fees go to MuRewards. The owner can point `feeRecipient`
anywhere at any time with `setFee` (only not at MuOTC itself).

## Install, test, export

Run every heavy command through the machine governor (mandatory on TRON):

```sh
cd contracts/otc
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm ci
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npx hardhat test
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm run test:gas     # gas table
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm run export       # release/otc/*.json
```

`node_modules` may instead be a junction to another Hardhat project with the
same pinned devDependencies (`contracts/dogy`).

Toolchain (exact pins, same as `contracts/dogy`): Hardhat 2.28.0, ethers
6.16.0, chai 4.5.0, OpenZeppelin Contracts 5.6.1, hardhat-gas-reporter 2.3.0;
solc 0.8.28, optimizer on, 200 runs, `evmVersion: cancun` (OZ 5.6 uses MCOPY;
Avalanche C-Chain has the Cancun opcodes since the Etna upgrade).

Current result: **58 passing** (55 MuOTC, 3 legacy), none skipped.

Typical gas (hardhat, warm storage): `createOrder` ERC-20→ERC-20 about 299k,
NFT→NFT about 327k, reserved about 363k (one more index write); `fillOrder`
about 145k (ERC-20) / 179k (NFT); `cancelOrder` about 59k. The legacy
three-step flow cost about 294k + 77k + 78k + 91k.

### The bytecode hash

`release/otc/MuOTC.json` carries `deployedBytecodeHash = keccak256(deployedBytecode)`.
The Worker verifies a deployment with `keccak256(eth_getCode(address))`. This
works because MuOTC has **no immutables**: the runtime code does not depend on
constructor arguments (the export script refuses to write otherwise, and the
tests deploy with different arguments and compare). The hash also commits to
the compiler settings and to every source byte through the metadata hash, so
any edit to a `.sol` file, a comment included, needs a fresh export.
`.gitattributes` keeps this folder LF-only so a fresh clone on any OS compiles
to the same hash.

## Deploying (Jon)

Jon deploys from his own wallet through the OTC admin panel on
**new.mu.money** (`/admin/otc`). The panel sends `bytecode` from
`release/otc/MuOTC.json` with the constructor arguments from its `defaults`:

| Argument | Value |
| --- | --- |
| `feeToken_` | `0xF7ed17f0Fb2B7C9D3DDBc9F0679b2e1098993e81` (MUG) |
| `feeAmount_` | `1000000000000000000` (1 MUG) |
| `feeRecipient_` | `0x12127E06c0A2C82368BFC9C5a05E86B24429838a` (MuRewards, see above) |

The deploying wallet becomes the owner. After deploying, the Worker checks the
code hash. Nothing in this folder holds a key or deploys anywhere.

## Known limitations

- No partial fills: an order is filled entirely or not at all.
- No native AVAX: trade WAVAX.
- Fee-on-transfer and rebasing ERC-20s are rejected. A token that adds a
  transfer fee after an order was created makes that order unfillable (the
  maker can still cancel, subject to the token's own rules).
- ERC-1155 is not supported. An ERC-20 side whose token reports ERC-721 via
  ERC-165 is rejected (`NotAnERC20`) because an NFT escrowed as an ERC-20 could
  never be released.
- Tokens that can freeze, blocklist or pause transfers can block a fill or a
  refund for as long as the token issuer keeps them blocked.
- The open set is unordered (swap-and-pop), so open-order pages can shift
  between calls while orders are filled or cancelled. Maker and taker indexes
  are append-only, oldest first.
- The contract cannot judge tokens: anyone can list a fake token with a real
  token's name. The UI should show addresses and mark known tokens.
