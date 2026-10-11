# MU Dogy contracts

Two contracts for Avalanche C-Chain. **Neither is deployed** (no mainnet, no
testnet). Spec: `docs/dogy/SPEC.md`.

| Contract | What it is |
| --- | --- |
| `MuDogy` | The real birthing engine: a Dogy is born by **burning a MU Pup and paying MUG**, then the owner can re-roll it (paid, +1 MUG each time) and finally lock it with a name. |
| `MuDogyTest` | A small demo NFT for real on-chain **test mints**. No Pup burn and no MUG (both simulated off-chain); minting needs a voucher signed by the demo server. Its artifact is exported to `release/dogy/MuDogyTest.json` for the web page. |

## Install and test

Run heavy commands through the machine governor (mandatory on TRON):

```sh
cd portal/contracts/dogy
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm ci
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npx hardhat test
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npm run test:gas            # gas table
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npx hardhat run scripts/deploy-fuji.cjs   # local dry run
node C:\projects\.agent-bridge\guard.mjs run --kind build -- npx hardhat run scripts/export-mudogytest.cjs
```

Current result: **65 passing** (54 MuDogy, 11 MuDogyTest), none skipped.

Toolchain (exact pins): Hardhat 2.28.0, ethers 6.16.0, chai 4.5.0,
OpenZeppelin Contracts 5.6.1, hardhat-gas-reporter 2.3.0. MuDogy compiles with
solc 0.8.28, MuDogyTest with solc 0.8.24, both with the optimizer on (200 runs)
and `evmVersion: cancun`. OZ 5.6 uses MCOPY, so it needs Cancun; Avalanche
C-Chain has had the Cancun opcodes since the Etna upgrade. MuDogyTest's runtime
code happens to contain no Cancun-only opcodes.

Files use `.cjs` so the portal's ESM/browser ESLint config does not lint them.

## User flow (MuDogy)

```
1. MUG.approve(MuDogy, price)                         tx 1  ┐ "Birth"
2. Pups.safeTransferFrom(holder, MuDogy, pupId)        tx 2  ┘ Pup burned, MUG paid, Dogy NFT minted (unlocked)
3. (optional, repeat) MUG.approve(MuDogy, cost)
                      MuDogy.reroll(dogyId, table)     one table's seed replaced, climbing MUG cost
4. MuDogy.lock(dogyId, "Name")                         the UI's "Mint Dogy" button: named, seeds frozen
```

What happens in tx 2 (`onERC721Received`):

- The call must come from the Pups contract and be started by the holder
  (`operator == from`). An approved marketplace operator can not burn your Pup
  and spend your MUG.
- The Pup must be in range (#0–349), not blocked (#349 "MU" is blocked at deploy),
  and never used before.
- Takes `price` MUG from the holder **straight to the treasury** (SafeERC20).
- Burns the Pup. Mintpeg's `burn` only works for the owner, which is why MuDogy
  receives the Pup first.
- Snapshots `muo.balanceOf(holder)` and `muv.balanceOf(holder)`, derives three
  seeds, mints the next Dogy id (starting at 1) to the holder, and records the
  birth.
- If anything fails, the whole transfer reverts and the holder keeps the Pup and
  the MUG.

Edition comes from the Pup id: #0–99 is Edition 1, #100–349 is Edition 2.

Use `safeTransferFrom`. A plain `transferFrom` skips the hook, so no Dogy is born
and the Pup sits in the contract until the owner calls `returnStrandedPup`.

### Birth record: `births(dogyId)`

| Field | Meaning |
| --- | --- |
| `pupId` | Parent Pup (burned) |
| `birthTime` | Block timestamp at birth |
| `edition` | 1 or 2 |
| `locked` | `true` after `lock`: no more rerolls |
| `rerollCounts[3]` | Rerolls so far for Core, Power, Traits |
| `seeds[3]` | Current seed for Core, Power, Traits |
| `sacrifice` | Total MUG wei paid for this Dogy: birth price plus every reroll |
| `muo`, `muv` | Holder's MUO / MUV balance at birth (wei) |
| `name` | Set by `lock`, 1–32 bytes of UTF-8 |

Read fields by name: the struct order is chosen for storage packing. Other views:
`dogyOfPup(pupId)` (0 = none), `totalSupply()`, `nextDogyId()`,
`nextRerollCost(dogyId, table)`, `rerollCostAt(n)`, `blocked(pupId)`.
`tokenURI(id)` = `baseURI + id`, default `https://new.mu.money/nft/mu-dogy/`.
There are no on-chain traits: the metadata server computes them from this record.

Events: `Birth(dogyId, owner, pupId, seeds[3], muo, muv, edition)`,
`Reroll(dogyId, table, newSeed, count, cost)`, `Locked(dogyId, name, seeds[3])`,
plus ERC-4906 `MetadataUpdate` / `BatchMetadataUpdate` so marketplaces refresh.

### Seeds

```
birth:  seeds[t] = keccak256(abi.encode(prevrandao, blockhash(n-1), holder, pupId, dogyId, MuDogy, t))   t = 0,1,2
reroll: seeds[t] = keccak256(abi.encode(prevrandao, blockhash(n-1), owner, pupId, dogyId, MuDogy, t, count, oldSeed))
```

Tables: `0 = Core` (element, pendant, guardian), `1 = Power` (strength, hit
points, agility), `2 = Traits` (visual traits).

## Re-roll economics

The n-th reroll **of a table** costs:

```
cost(n) = rerollBase + rerollStep × (n−1)
```

A straight line, not a curve (Jon, 2026-10-11). It used to be a multiplier,
and ×1.5 put 24 rerolls of one table at 67,000 MUG, most of the 100,000 MUG
there are.

- Each table has its own count. Rerolling Power never changes the Core or Traits
  seed or their prices.
- The owner sets `rerollBase` and `rerollStep` (both MUG wei). A step of 0 is a
  flat price; base and step both 0 make rerolls free (test mode).
- A pricing change applies from the next reroll and continues from the Dogy's
  existing counts.
- The count belongs to the Dogy, not the owner: a new owner continues the
  climb.
- Every reroll's MUG goes straight to the treasury and is added to `sacrifice`.
- If a cost would overflow, the view returns `type(uint256).max`, which makes
  that reroll unpayable.

Example: base 2 MUG, step 1 MUG (the Fuji script defaults):

| Reroll of one table | 1st | 2nd | 3rd | 4th | 5th | 24th | Total for 24 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MUG | 2 | 3 | 4 | 5 | 6 | 25 | 324 |

A Perfect Alignment is 1 Core roll in 25, so chasing one costs about 624 MUG
on average.

Five rerolls on all three tables cost 79.125 MUG on top of the birth price.

Only the Dogy's current owner can reroll or lock it. Approved operators can not.
`reroll` reverts while paused or once the Dogy is locked. `lock` works while
paused, because it moves no value and only removes options.

## Randomness: not manipulation-proof (traits are cosmetic)

The seed inputs are `block.prevrandao` and the previous blockhash.

- **Validators** see and influence both of them.
- **On Avalanche C-Chain, `prevrandao` carries no beacon-chain randomness**, so
  the only real entropy is the previous blockhash, and that is public before the
  transaction runs.
- **A holder using a smart contract can refuse outcomes for free.** The contract
  can compute the seed in the same transaction, or simply revert after seeing
  it. A reverted birth keeps the Pup. A reverted reroll refunds its MUG. Two
  tests demonstrate this ("known randomness limitation").
- **With paid rerolls this matters.** Sophisticated users can pick any outcome
  and only pay for the one they keep, so the escalating price only binds normal
  wallets.

Upgrade path: **Chainlink VRF** (live on Avalanche), or commit-reveal. In both,
the MUG is committed in one transaction and the seed is fixed in a later one, so
there is nothing to revert. Either change also changes the UX (an extra wait or
transaction per roll).

## Trust and safety notes

- **No owner backdoors.** The owner can not move, burn, rename or reroll anyone's
  Dogy, and the contract never holds MUG. There is no withdraw, no upgradeability
  and no payable function. A test pins the exact list of state-changing
  functions.
- **Owner powers:**
  - `setPrice`, `setTreasury` and `setRerollPricing`
  - `setBaseURI`, `refreshMetadata`, `setBlocked` and `setRoyalty` (cap 10%)
  - `pause` and `unpause`
  - `returnStrandedPup` (only for Pups sent by plain `transferFrom`)
  - Ownership moves with Ownable2Step: `transferOwnership`, then `acceptOwnership`.
- **Reentrancy.** Births and rerolls are `nonReentrant` and write their state
  before any external call. Tests try to re-enter from a malicious MUG
  (birth→birth, birth→reroll, reroll→birth) and from a contract holder's mint
  callback.
- **Pups contract trust.** MuDogy trusts whatever code runs at the Pups address.
  Mintpeg is built from initializer-based (upgradeable-style) OpenZeppelin
  contracts.
  - **Check on Snowtrace whether `0x34A0…49c0` is an EIP-1167 clone (fixed code)
    or an upgradeable proxy.** If it is upgradeable, whoever controls upgrades
    could fake a birth and spend any MUG allowance users gave MuDogy.
  - Either way, the UI should approve **exactly `price`** (or the exact reroll
    cost), not an unlimited amount.
- **Unlocked Dogys are transferable.** A seller could list an unlocked Dogy and
  reroll it before the sale settles. The UI and metadata should show the lock
  state clearly (see decisions).
- **Names** are stored as given (1–32 bytes, any UTF-8). The metadata server must
  JSON-escape them.

## MuDogyTest (demo NFT)

- **Contract:** `constructor(signer, baseURI)`, where the page passes
  `https://new.mu.money/nft/mu-dogy-test/`. Owner = deployer.
- **Mint:** `mint(dogyId, dna, signature)` mints token id `dogyId` to the caller
  and stores `dna[dogyId]`.
- **Voucher:** `signer` personal_signs (EIP-191) the 32-byte hash
  ```
  keccak256(abi.encodePacked(block.chainid, address(this), msg.sender, dogyId, dna))
  ```
  ethers v6 version:
  `wallet.signMessage(ethers.getBytes(ethers.solidityPackedKeccak256(["uint256","address","address","uint256","bytes32"], [chainId, contract, to, dogyId, dna])))`.
  `voucherHash(to, dogyId, dna)` returns the same hash on-chain.
- **What a voucher is bound to:** one chain, one contract, one wallet, one id and
  one DNA. An id mints only once.
- **Owner functions:** `setSigner` and `setBaseURI`. `totalMinted()` counts
  mints.
- **Verifying a deployment:** MuDogyTest has no immutables, so
  `keccak256(eth_getCode(addr))` must equal `deployedBytecodeHash` in
  `release/dogy/MuDogyTest.json`. That hash is currently
  `0x7e55dad7c58628185270adbb2da8bb84245f35973b1dc557d744b82d15f0410d`.
- **Re-export** with `scripts/export-mudogytest.cjs` after any change to the
  source, compiler or settings. The hash will change.

## Fuji testnet deploy (script written, NOT run)

`scripts/deploy-fuji.cjs` deploys mock Pups (Mintpeg replica with the same
owner-only `burn`), mock MUG/MUO/MUV (open-mint 18-decimal ERC-20s) and MuDogy.

It then mints test assets to the deployer and to `TESTERS`:
- Pups #0–2 plus #99, 100, 101, 200, 348 and 349.
- 1000 MUG, 30 MUO and 12 MUV each.

The script refuses any chain except Fuji (43113) and the in-process Hardhat
chain. Fuji also requires `CONFIRM_FUJI_DEPLOY=yes`.

```sh
# local dry run (deploys to a throwaway in-memory chain, does birth -> reroll -> lock)
npx hardhat run scripts/deploy-fuji.cjs
# Fuji (when Jon says so)
FUJI_PRIVATE_KEY=0x... CONFIRM_FUJI_DEPLOY=yes DOGY_BASE_URI=https://new.mu.money/nft/mu-dogy-fuji/ \
  npx hardhat run scripts/deploy-fuji.cjs --network fuji
```

Other env: `DOGY_OWNER`, `DOGY_TREASURY`, `DOGY_PRICE_MUG` (default 10),
`DOGY_REROLL_BASE_MUG` (2), `DOGY_REROLL_STEP_MUG` (1), `TESTERS`
(comma list), `DEMO_BIRTH=1`. On Fuji it writes `deployments/fuji.json`. No
mainnet network is configured, on purpose.

Gas (Hardhat, from the gas report): birth ≈ 300–390k (the whole `safeTransferFrom`),
first reroll ≈ 91k, lock ≈ 63k. MuDogy runtime size is 12.8 KB (limit 24 KB).

## Decisions Jon must make before mainnet

1. **Birth price** in MUG (spec demo default: 10). `0` is allowed (free).
2. **Treasury.** Use a plain wallet, ideally a multisig, not the MU rewards
   contract `0x12127E06c0A2C82368BFC9C5a05E86B24429838a`.
   - Its `withdrawlOverride(address token)` is **public with no access check**.
     Anyone can call it at any time to send the contract's whole balance of any
     token to the hard-coded `0xF243d79910cBd70a0eaF405b08E80065a67D5e14`.
   - So MUG sent there can be moved away before it is ever paid to MUO holders.
   - Pay holders from the treasury on purpose instead.
3. **Randomness.** Either accept block-based seeds (cosmetic traits only, and
   anyone using a contract wallet can game rerolls), or move to Chainlink VRF or
   commit-reveal before mainnet. This is the most important call now that rerolls
   cost MUG.
4. **Reroll pricing**: `rerollBase` and `rerollStep` (Jon: 2 MUG, +1 MUG each time), and
   whether rerolls need a hard cap.
5. **Royalty**: receiver and rate (none is set at deploy; cap 10%).
6. **Pup #349 "MU"**: keep it blocked, or decide what burning it means.
7. **Unlocked transfers**: allow them (current), auto-lock on the first
   transfer, or block transfers until locked.
8. **Owner**: a multisig. Ownership moves only by two-step transfer.
9. **`returnStrandedPup`**: keep it (rescues mistaken plain transfers) or remove
   it.
10. **Final base URI**, and confirm the Pups contract type and admin (see
    "Pups contract trust").
11. **An external audit** before mainnet value flows through it.

## Layout

```
contracts/MuDogy.sol              birthing engine
contracts/MuDogyTest.sol          demo voucher-mint NFT
contracts/interfaces/IMuPups.sol  Mintpeg interface (ERC-721 + owner-only burn)
contracts/mocks/                  MockMintpeg, MockERC20, ReentrantMUG, ContractHolder (tests / Fuji only)
test/MuDogy.test.cjs              54 tests
test/MuDogyTest.test.cjs          11 tests
scripts/deploy-fuji.cjs           Fuji deploy (not run) / local dry run
scripts/export-mudogytest.cjs     writes release/dogy/MuDogyTest.json
hardhat.config.cjs                compilers, Fuji network (no mainnet)
hardhat.gas.config.cjs            same + gas reporter
```
