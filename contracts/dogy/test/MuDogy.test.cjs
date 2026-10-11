const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);
const PRICE = E(10);
const REROLL_BASE = E(2);
const STEP = E(1); // each reroll of a table costs 1 MUG more than its last: 2, 3, 4 ...
const ZERO = ethers.ZeroAddress;
const SAFE = "safeTransferFrom(address,address,uint256)";
const SAFE_DATA = "safeTransferFrom(address,address,uint256,bytes)";
const T = { Core: 0, Power: 1, Traits: 2 };
const coder = ethers.AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------- fixtures

async function deployFixture() {
  const [owner, treasury, alice, bob, carol, newOwner] = await ethers.getSigners();

  const Mintpeg = await ethers.getContractFactory("MockMintpeg");
  const pups = await Mintpeg.deploy("MU Pups", "MUPUP");
  const otherNft = await Mintpeg.deploy("Not A Pup", "NOPE");

  const ERC20 = await ethers.getContractFactory("MockERC20");
  const mug = await ERC20.deploy("MU Gold", "MUG");
  const muo = await ERC20.deploy("MU Ore", "MUO");
  const muv = await ERC20.deploy("MU Vault", "MUV");

  const Dogy = await ethers.getContractFactory("MuDogy");
  const dogy = await Dogy.deploy(owner.address, pups, mug, muo, muv, treasury.address, PRICE, REROLL_BASE, STEP, "");

  // Pups: alice #0-#4 (sequential, like Mintpeg), plus edition-boundary ids.
  await pups.mint(alice.address, 5);
  for (const id of [99, 100, 348, 349]) await pups.mintId(alice.address, id);
  await pups.mintId(bob.address, 101);
  await pups.mintId(carol.address, 102);
  await otherNft.mint(alice.address, 1); // "Not A Pup" #0

  await mug.mint(alice.address, E(1000));
  await mug.mint(bob.address, E(1000));
  await muo.mint(alice.address, E(30)); // Silver Collar tier
  await muv.mint(alice.address, E(12)); // Radiant Aura tier

  return { owner, treasury, alice, bob, carol, newOwner, pups, otherNft, mug, muo, muv, dogy, Dogy };
}

/** Fixture with Dogy #1 born to alice from Pup #3. */
async function bornFixture() {
  const ctx = await deployFixture();
  await birth(ctx, ctx.alice, 3);
  return ctx;
}

// ----------------------------------------------------------------- helpers

async function birth(ctx, signer, pupId, { approve = true } = {}) {
  if (approve) await ctx.mug.connect(signer).approve(ctx.dogy, await ctx.dogy.price());
  return ctx.pups.connect(signer)[SAFE](signer.address, ctx.dogy, pupId);
}

async function rawBlock(blockNumber) {
  return ethers.provider.send("eth_getBlockByNumber", [ethers.toQuantity(blockNumber), false]);
}

/** Seeds the contract must have derived at birth (block.prevrandao == mixHash post-merge). */
async function expectedBirthSeeds(receipt, from, pupId, dogyId, dogyAddr) {
  const b = await rawBlock(receipt.blockNumber);
  return [0, 1, 2].map((t) =>
    ethers.keccak256(
      coder.encode(
        ["uint256", "bytes32", "address", "uint256", "uint256", "address", "uint256"],
        [b.mixHash, b.parentHash, from, pupId, dogyId, dogyAddr, t],
      ),
    ),
  );
}

async function expectedRerollSeed(receipt, sender, pupId, dogyId, dogyAddr, table, n, oldSeed) {
  const b = await rawBlock(receipt.blockNumber);
  return ethers.keccak256(
    coder.encode(
      ["uint256", "bytes32", "address", "uint256", "uint256", "address", "uint256", "uint256", "bytes32"],
      [b.mixHash, b.parentHash, sender, pupId, dogyId, dogyAddr, table, n, oldSeed],
    ),
  );
}

function parseEvent(contract, receipt, name) {
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.target.toLowerCase()) continue;
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) out.push(parsed);
    } catch (_) {
      /* not this contract's event */
    }
  }
  return out;
}

async function approveAndReroll(ctx, signer, dogyId, table) {
  const cost = await ctx.dogy.nextRerollCost(dogyId, table);
  if (cost > 0n) await ctx.mug.connect(signer).approve(ctx.dogy, cost);
  const tx = await ctx.dogy.connect(signer).reroll(dogyId, table);
  return { tx, cost, receipt: await tx.wait() };
}

// ------------------------------------------------------------------- tests

describe("MuDogy", function () {
  describe("deployment", function () {
    it("sets name, symbol, owner, tokens, treasury and pricing", async function () {
      const { dogy, owner, treasury, pups, mug, muo, muv } = await loadFixture(deployFixture);
      expect(await dogy.name()).to.equal("MU Dogy");
      expect(await dogy.symbol()).to.equal("MUDOGY");
      expect(await dogy.owner()).to.equal(owner.address);
      expect(await dogy.pendingOwner()).to.equal(ZERO);
      expect(await dogy.pups()).to.equal(pups.target);
      expect(await dogy.mug()).to.equal(mug.target);
      expect(await dogy.muo()).to.equal(muo.target);
      expect(await dogy.muv()).to.equal(muv.target);
      expect(await dogy.treasury()).to.equal(treasury.address);
      expect(await dogy.price()).to.equal(PRICE);
      expect(await dogy.rerollBase()).to.equal(REROLL_BASE);
      expect(await dogy.rerollStep()).to.equal(STEP);
      expect(await dogy.totalSupply()).to.equal(0n);
      expect(await dogy.nextDogyId()).to.equal(1n);
      expect(await dogy.paused()).to.equal(false);
      expect(await dogy.MAX_PUP_ID()).to.equal(349n);
      expect(await dogy.EDITION_1_LAST_PUP()).to.equal(99n);
      expect(await dogy.TABLE_COUNT()).to.equal(3n);
      expect(await dogy.MAX_NAME_BYTES()).to.equal(32n);
    });

    it("blocks Pup #349 'MU' from the start, and nothing else", async function () {
      const { dogy } = await loadFixture(deployFixture);
      expect(await dogy.blocked(349)).to.equal(true);
      expect(await dogy.blocked(348)).to.equal(false);
      expect(await dogy.blocked(0)).to.equal(false);
    });

    it("uses https://new.mu.money/nft/mu-dogy/ when baseURI is empty, or the one given", async function () {
      const ctx = await loadFixture(deployFixture);
      await birth(ctx, ctx.alice, 0);
      expect(await ctx.dogy.tokenURI(1)).to.equal("https://new.mu.money/nft/mu-dogy/1");

      const custom = await ctx.Dogy.deploy(
        ctx.owner.address, ctx.pups, ctx.mug, ctx.muo, ctx.muv, ctx.treasury.address, 0, 0, STEP, "ipfs://dogy/",
      );
      await ctx.pups.connect(ctx.alice)[SAFE](ctx.alice.address, custom, 1);
      expect(await custom.tokenURI(1)).to.equal("ipfs://dogy/1");
    });

    it("rejects zero addresses", async function () {
      const { Dogy, owner, treasury, pups, mug, muo, muv } = await loadFixture(deployFixture);
      const args = [owner.address, pups.target, mug.target, muo.target, muv.target, treasury.address, PRICE, REROLL_BASE, STEP, ""];
      for (const i of [1, 2, 3, 4, 5]) {
        const bad = [...args];
        bad[i] = ZERO;
        await expect(Dogy.deploy(...bad)).to.be.revertedWithCustomError(Dogy, "ZeroAddress");
      }
      const noOwner = [...args];
      noOwner[0] = ZERO;
      await expect(Dogy.deploy(...noOwner)).to.be.revertedWithCustomError(Dogy, "OwnableInvalidOwner").withArgs(ZERO);
    });

    it("advertises ERC-165, ERC-721, ERC-721 Metadata, ERC-2981 and ERC-4906", async function () {
      const { dogy } = await loadFixture(deployFixture);
      for (const id of ["0x01ffc9a7", "0x80ac58cd", "0x5b5e139f", "0x2a55205a", "0x49064906"]) {
        expect(await dogy.supportsInterface(id), id).to.equal(true);
      }
      expect(await dogy.supportsInterface("0xffffffff")).to.equal(false);
      expect(await dogy.supportsInterface("0x780e9d63")).to.equal(false); // not ERC721Enumerable
    });
  });

  describe("birth (Pup burn + MUG)", function () {
    it("moves MUG to the treasury, burns the Pup, mints Dogy #1 and records the birth", async function () {
      const ctx = await loadFixture(deployFixture);
      const { dogy, pups, mug, alice, treasury } = ctx;
      const pupsBefore = await pups.balanceOf(alice.address);

      const tx = await birth(ctx, alice, 3);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx).to.changeTokenBalances(mug, [alice, treasury, dogy], [-PRICE, PRICE, 0n]);
      await expect(tx).to.emit(mug, "Transfer").withArgs(alice.address, treasury.address, PRICE);
      await expect(tx).to.emit(pups, "Transfer").withArgs(alice.address, dogy.target, 3);
      await expect(tx).to.emit(pups, "Transfer").withArgs(dogy.target, ZERO, 3);
      await expect(tx).to.emit(dogy, "Transfer").withArgs(ZERO, alice.address, 1);

      // Pup is gone for good.
      await expect(pups.ownerOf(3)).to.be.revertedWithCustomError(pups, "ERC721NonexistentToken").withArgs(3);
      expect(await pups.balanceOf(alice.address)).to.equal(pupsBefore - 1n);
      expect(await pups.balanceOf(dogy.target)).to.equal(0n);

      // Dogy #1 belongs to alice.
      expect(await dogy.ownerOf(1)).to.equal(alice.address);
      expect(await dogy.balanceOf(alice.address)).to.equal(1n);
      expect(await dogy.totalSupply()).to.equal(1n);
      expect(await dogy.nextDogyId()).to.equal(2n);
      expect(await dogy.dogyOfPup(3)).to.equal(1n);
      expect(await dogy.dogyOfPup(4)).to.equal(0n);
      expect(await mug.allowance(alice.address, dogy.target)).to.equal(0n);

      // Birth record.
      const seeds = await expectedBirthSeeds(receipt, alice.address, 3, 1, dogy.target);
      const b = await dogy.births(1);
      expect(b.pupId).to.equal(3n);
      expect(b.birthTime).to.equal(BigInt(block.timestamp));
      expect(b.edition).to.equal(1n);
      expect(b.locked).to.equal(false);
      expect([...b.rerollCounts]).to.deep.equal([0n, 0n, 0n]);
      expect([...b.seeds]).to.deep.equal(seeds);
      expect(b.sacrifice).to.equal(PRICE);
      expect(b.muo).to.equal(E(30));
      expect(b.muv).to.equal(E(12));
      expect(b.name).to.equal("");

      // Birth event.
      const [ev] = parseEvent(dogy, receipt, "Birth");
      expect(ev.args.dogyId).to.equal(1n);
      expect(ev.args.owner).to.equal(alice.address);
      expect(ev.args.pupId).to.equal(3n);
      expect([...ev.args.seeds]).to.deep.equal(seeds);
      expect(ev.args.muo).to.equal(E(30));
      expect(ev.args.muv).to.equal(E(12));
      expect(ev.args.edition).to.equal(1n);
    });

    it("derives three distinct table seeds, and different seeds for every birth", async function () {
      const ctx = await loadFixture(deployFixture);
      const all = new Set();
      for (const pupId of [0, 1, 2]) await birth(ctx, ctx.alice, pupId);
      for (const id of [1, 2, 3]) {
        const b = await ctx.dogy.births(id);
        expect(b.pupId).to.equal(BigInt(id - 1));
        expect(new Set(b.seeds).size).to.equal(3);
        b.seeds.forEach((s) => all.add(s));
      }
      expect(all.size).to.equal(9);
      expect(await ctx.dogy.totalSupply()).to.equal(3n);
    });

    it("accepts safeTransferFrom with a data payload", async function () {
      const ctx = await loadFixture(deployFixture);
      await ctx.mug.connect(ctx.alice).approve(ctx.dogy, PRICE);
      await ctx.pups.connect(ctx.alice)[SAFE_DATA](ctx.alice.address, ctx.dogy, 2, "0x1234");
      expect(await ctx.dogy.ownerOf(1)).to.equal(ctx.alice.address);
    });

    it("gives Edition 1 for Pups #0-99 and Edition 2 for #100-349", async function () {
      const ctx = await loadFixture(deployFixture);
      await ctx.dogy.setBlocked(349, false);
      const cases = [
        [0, 1n],
        [99, 1n],
        [100, 2n],
        [348, 2n],
        [349, 2n],
      ];
      let id = 1;
      for (const [pupId, edition] of cases) {
        await birth(ctx, ctx.alice, pupId);
        const b = await ctx.dogy.births(id++);
        expect(b.pupId, `pup ${pupId}`).to.equal(BigInt(pupId));
        expect(b.edition, `pup ${pupId}`).to.equal(edition);
      }
    });

    it("snapshots the holder's MUO and MUV at birth and never changes it afterwards", async function () {
      const ctx = await loadFixture(deployFixture);
      const { dogy, muo, muv, alice, bob } = ctx;

      await birth(ctx, bob, 101); // bob holds no MUO/MUV
      let b = await dogy.births(1);
      expect(b.muo).to.equal(0n);
      expect(b.muv).to.equal(0n);

      await muo.connect(alice).transfer(bob.address, E(5)); // alice now 25 MUO
      await birth(ctx, alice, 0);
      b = await dogy.births(2);
      expect(b.muo).to.equal(E(25));
      expect(b.muv).to.equal(E(12));

      await muo.mint(alice.address, E(5000));
      await muv.mint(alice.address, E(5000));
      await muv.mint(bob.address, E(1));
      expect((await dogy.births(1)).muv).to.equal(0n);
      expect((await dogy.births(2)).muo).to.equal(E(25));
      expect((await dogy.births(2)).muv).to.equal(E(12));
    });

    it("price 0 is a free birth: no approval, no MUG, nothing sent to the treasury", async function () {
      const ctx = await loadFixture(deployFixture);
      const { dogy, mug, carol, treasury } = ctx;
      await dogy.setPrice(0);
      expect(await mug.balanceOf(carol.address)).to.equal(0n);

      const tx = await birth(ctx, carol, 102, { approve: false });
      await expect(tx).to.changeTokenBalances(mug, [carol, treasury], [0n, 0n]);
      await expect(tx).not.to.emit(mug, "Transfer");
      expect(await dogy.ownerOf(1)).to.equal(carol.address);
      expect((await dogy.births(1)).sacrifice).to.equal(0n);
    });

    it("charges the current price and pays the current treasury", async function () {
      const ctx = await loadFixture(deployFixture);
      const { dogy, mug, alice, bob, treasury } = ctx;
      await expect(dogy.setPrice(E(25))).to.emit(dogy, "PriceSet").withArgs(E(25));
      await expect(dogy.setTreasury(bob.address)).to.emit(dogy, "TreasurySet").withArgs(bob.address);

      const tx = await birth(ctx, alice, 0);
      await expect(tx).to.changeTokenBalances(mug, [alice, bob, treasury], [-E(25), E(25), 0n]);
      expect((await dogy.births(1)).sacrifice).to.equal(E(25));
    });
  });

  describe("birth reverts (and the Pup stays with its holder)", function () {
    it("refuses any ERC-721 that is not the Pups contract", async function () {
      const { dogy, otherNft, alice } = await loadFixture(deployFixture);
      await expect(otherNft.connect(alice)[SAFE](alice.address, dogy, 0))
        .to.be.revertedWithCustomError(dogy, "NotPupsContract")
        .withArgs(otherNft.target);
      expect(await otherNft.ownerOf(0)).to.equal(alice.address);
    });

    it("refuses a direct onERC721Received call trying to spend someone's MUG approval", async function () {
      const { dogy, mug, alice, bob } = await loadFixture(deployFixture);
      await mug.connect(alice).approve(dogy, E(1000));
      await expect(dogy.connect(bob).onERC721Received(bob.address, alice.address, 3, "0x"))
        .to.be.revertedWithCustomError(dogy, "NotPupsContract")
        .withArgs(bob.address);
      expect(await mug.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("refuses a birth started by an approved operator instead of the holder", async function () {
      const { dogy, pups, mug, alice, bob } = await loadFixture(deployFixture);
      await mug.connect(alice).approve(dogy, PRICE);
      await pups.connect(alice).setApprovalForAll(bob.address, true); // e.g. a marketplace
      await expect(pups.connect(bob)[SAFE](alice.address, dogy, 3))
        .to.be.revertedWithCustomError(dogy, "OperatorNotHolder")
        .withArgs(bob.address, alice.address);
      expect(await pups.ownerOf(3)).to.equal(alice.address);
      expect(await mug.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("reverts when MUG is not approved", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(birth(ctx, ctx.alice, 3, { approve: false }))
        .to.be.revertedWithCustomError(ctx.mug, "ERC20InsufficientAllowance")
        .withArgs(ctx.dogy.target, 0, PRICE);
      expect(await ctx.pups.ownerOf(3)).to.equal(ctx.alice.address);
      expect(await ctx.dogy.totalSupply()).to.equal(0n);
    });

    it("reverts when the MUG approval is below the price", async function () {
      const ctx = await loadFixture(deployFixture);
      await ctx.mug.connect(ctx.alice).approve(ctx.dogy, PRICE - 1n);
      await expect(ctx.pups.connect(ctx.alice)[SAFE](ctx.alice.address, ctx.dogy, 3))
        .to.be.revertedWithCustomError(ctx.mug, "ERC20InsufficientAllowance")
        .withArgs(ctx.dogy.target, PRICE - 1n, PRICE);
      expect(await ctx.pups.ownerOf(3)).to.equal(ctx.alice.address);
    });

    it("reverts when the holder has too little MUG", async function () {
      const ctx = await loadFixture(deployFixture);
      await ctx.mug.mint(ctx.carol.address, PRICE - 1n);
      await expect(birth(ctx, ctx.carol, 102))
        .to.be.revertedWithCustomError(ctx.mug, "ERC20InsufficientBalance")
        .withArgs(ctx.carol.address, PRICE - 1n, PRICE);
      expect(await ctx.pups.ownerOf(102)).to.equal(ctx.carol.address);
    });

    it("reverts while paused and works again after unpause", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.dogy.pause()).to.emit(ctx.dogy, "Paused");
      await expect(birth(ctx, ctx.alice, 3)).to.be.revertedWithCustomError(ctx.dogy, "EnforcedPause");
      expect(await ctx.pups.ownerOf(3)).to.equal(ctx.alice.address);
      await expect(ctx.dogy.unpause()).to.emit(ctx.dogy, "Unpaused");
      await birth(ctx, ctx.alice, 3);
      expect(await ctx.dogy.ownerOf(1)).to.equal(ctx.alice.address);
    });

    it("reverts for a blocked Pup (#349 by default) until it is unblocked", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(birth(ctx, ctx.alice, 349)).to.be.revertedWithCustomError(ctx.dogy, "PupIsBlocked").withArgs(349);
      expect(await ctx.pups.ownerOf(349)).to.equal(ctx.alice.address);

      await expect(ctx.dogy.setBlocked(4, true)).to.emit(ctx.dogy, "PupBlockedSet").withArgs(4, true);
      await expect(birth(ctx, ctx.alice, 4)).to.be.revertedWithCustomError(ctx.dogy, "PupIsBlocked").withArgs(4);

      await expect(ctx.dogy.setBlocked(349, false)).to.emit(ctx.dogy, "PupBlockedSet").withArgs(349, false);
      await birth(ctx, ctx.alice, 349);
      expect((await ctx.dogy.births(1)).pupId).to.equal(349n);
    });

    it("reverts for Pup ids above #349", async function () {
      const ctx = await loadFixture(deployFixture);
      await ctx.pups.mintId(ctx.alice.address, 350);
      await expect(birth(ctx, ctx.alice, 350)).to.be.revertedWithCustomError(ctx.dogy, "PupOutOfRange").withArgs(350);
    });

    it("a burned Pup can not be used again, even if the Pups proxy re-minted its id", async function () {
      const ctx = await bornFixture(); // Pup #3 -> Dogy #1
      // The burned Pup no longer exists, so it can not be sent again.
      await ctx.mug.connect(ctx.alice).approve(ctx.dogy, PRICE);
      await expect(ctx.pups.connect(ctx.alice)[SAFE](ctx.alice.address, ctx.dogy, 3))
        .to.be.revertedWithCustomError(ctx.pups, "ERC721NonexistentToken")
        .withArgs(3);
      // Simulate an upgraded Pups contract re-minting #3: still refused.
      await ctx.pups.mintId(ctx.bob.address, 3);
      await expect(birth(ctx, ctx.bob, 3)).to.be.revertedWithCustomError(ctx.dogy, "PupAlreadyUsed").withArgs(3, 1);
      expect(await ctx.dogy.totalSupply()).to.equal(1n);
    });

    it("a Pup sent with plain transferFrom gets no Dogy; only the owner can return it", async function () {
      const { dogy, pups, alice, bob } = await loadFixture(deployFixture);
      await pups.connect(alice).transferFrom(alice.address, dogy.target, 4); // skips the hook
      expect(await pups.ownerOf(4)).to.equal(dogy.target);
      expect(await dogy.totalSupply()).to.equal(0n);

      await expect(dogy.connect(bob).returnStrandedPup(4, bob.address))
        .to.be.revertedWithCustomError(dogy, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);
      await expect(dogy.returnStrandedPup(4, ZERO)).to.be.revertedWithCustomError(dogy, "ZeroAddress");
      await expect(dogy.returnStrandedPup(0, alice.address)).to.be.revertedWithCustomError(dogy, "PupNotHeld").withArgs(0);
      await expect(dogy.returnStrandedPup(4, alice.address)).to.emit(dogy, "PupReturned").withArgs(4, alice.address);
      expect(await pups.ownerOf(4)).to.equal(alice.address);
    });

    it("a Dogy sent to the MuDogy contract itself is refused (cannot get stuck)", async function () {
      const ctx = await bornFixture();
      await expect(ctx.dogy.connect(ctx.alice)[SAFE](ctx.alice.address, ctx.dogy, 1))
        .to.be.revertedWithCustomError(ctx.dogy, "NotPupsContract")
        .withArgs(ctx.dogy.target);
    });
  });

  describe("re-roll tables (Core, Power, Traits)", function () {
    it("climbs per table: 1st, 2nd, 3rd reroll cost base, +1 MUG, +2 MUG", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, mug, alice, treasury } = ctx;
      const expected = [E(2), E(3), E(4)];
      for (let i = 0; i < 3; i++) {
        expect(await dogy.nextRerollCost(1, T.Core)).to.equal(expected[i]);
        const { tx, cost } = await approveAndReroll(ctx, alice, 1, T.Core);
        expect(cost).to.equal(expected[i]);
        await expect(tx).to.changeTokenBalances(mug, [alice, treasury, dogy], [-expected[i], expected[i], 0n]);
        await expect(tx).to.emit(dogy, "Reroll").withArgs(1, T.Core, (await dogy.births(1)).seeds[T.Core], i + 1, expected[i]);
        await expect(tx).to.emit(dogy, "MetadataUpdate").withArgs(1);
      }
      expect(await dogy.nextRerollCost(1, T.Core)).to.equal(E(5));
      expect([...(await dogy.births(1)).rerollCounts]).to.deep.equal([3n, 0n, 0n]);
    });

    it("tables are independent: rerolling Power changes only the Power seed and count", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, alice } = ctx;
      const before = await dogy.births(1);
      await approveAndReroll(ctx, alice, 1, T.Power);
      const after = await dogy.births(1);
      expect(after.seeds[T.Core]).to.equal(before.seeds[T.Core]);
      expect(after.seeds[T.Traits]).to.equal(before.seeds[T.Traits]);
      expect(after.seeds[T.Power]).to.not.equal(before.seeds[T.Power]);
      expect([...after.rerollCounts]).to.deep.equal([0n, 1n, 0n]);

      // Each table climbs on its own count.
      expect(await dogy.nextRerollCost(1, T.Power)).to.equal(E(3));
      expect(await dogy.nextRerollCost(1, T.Core)).to.equal(E(2));
      expect(await dogy.nextRerollCost(1, T.Traits)).to.equal(E(2));
      await approveAndReroll(ctx, alice, 1, T.Traits);
      await approveAndReroll(ctx, alice, 1, T.Power);
      const last = await dogy.births(1);
      expect(last.seeds[T.Core]).to.equal(before.seeds[T.Core]);
      expect([...last.rerollCounts]).to.deep.equal([0n, 2n, 1n]);
      expect(await dogy.nextRerollCost(1, T.Power)).to.equal(E(4));
      expect(await dogy.nextRerollCost(1, T.Traits)).to.equal(E(3));
    });

    it("every reroll gives a new seed derived from the documented formula", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, alice } = ctx;
      const seen = new Set((await dogy.births(1)).seeds);
      for (let n = 1; n <= 4; n++) {
        const old = (await dogy.births(1)).seeds[T.Traits];
        const { receipt } = await approveAndReroll(ctx, alice, 1, T.Traits);
        const now = (await dogy.births(1)).seeds[T.Traits];
        expect(now).to.equal(await expectedRerollSeed(receipt, alice.address, 3, 1, dogy.target, T.Traits, n, old));
        expect(seen.has(now)).to.equal(false);
        seen.add(now);
      }
    });

    it("rerollCostAt is base + step * (n-1), and saturates instead of overflowing", async function () {
      const { dogy } = await loadFixture(deployFixture);
      // The default: 2, 3, 4 ... so 24 rerolls of one table cost 324 MUG in all.
      expect(await dogy.rerollCostAt(0)).to.equal(0n);
      expect(await dogy.rerollCostAt(1)).to.equal(E(2));
      expect(await dogy.rerollCostAt(24)).to.equal(E(25));
      let total = 0n;
      for (let n = 1; n <= 24; n++) total += await dogy.rerollCostAt(n);
      expect(total).to.equal(E(324));

      await dogy.setRerollPricing(7, 3);
      expect(await dogy.rerollCostAt(1)).to.equal(7n);
      expect(await dogy.rerollCostAt(2)).to.equal(10n);
      expect(await dogy.rerollCostAt(4)).to.equal(16n);

      await dogy.setRerollPricing(E(5), 0); // flat
      expect(await dogy.rerollCostAt(1)).to.equal(E(5));
      expect(await dogy.rerollCostAt(50)).to.equal(E(5));

      const huge = ethers.MaxUint256 / 4n;
      await dogy.setRerollPricing(E(1), huge);
      expect(await dogy.rerollCostAt(2)).to.equal(E(1) + huge);
      expect(await dogy.rerollCostAt(500)).to.equal(ethers.MaxUint256);
      expect(await dogy.rerollCostAt(ethers.MaxUint256)).to.equal(ethers.MaxUint256);
    });

    it("rerollBase 0 and rerollStep 0 make rerolls free (no approval, no MUG moved)", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, mug, alice, treasury } = ctx;
      await expect(dogy.setRerollPricing(0, 0)).to.emit(dogy, "RerollPricingSet").withArgs(0, 0);
      for (let i = 1; i <= 3; i++) {
        expect(await dogy.nextRerollCost(1, T.Core)).to.equal(0n);
        const tx = dogy.connect(alice).reroll(1, T.Core);
        await expect(tx).to.changeTokenBalances(mug, [alice, treasury], [0n, 0n]);
        await expect(tx).to.emit(dogy, "Reroll").withArgs(1, T.Core, (await dogy.births(1)).seeds[T.Core], i, 0);
      }
      const b = await dogy.births(1);
      expect(b.rerollCounts[T.Core]).to.equal(3n);
      expect(b.sacrifice).to.equal(PRICE); // only the birth price
    });

    it("tracks sacrifice = birth price + every reroll, all of it in the treasury", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, mug, alice, treasury } = ctx;
      // Core 2 + Core 3 + Power 2 + Traits 2 + Traits 3 + Traits 4 = 16
      for (const t of [T.Core, T.Core, T.Power, T.Traits, T.Traits, T.Traits]) await approveAndReroll(ctx, alice, 1, t);
      const total = PRICE + E(16);
      expect((await dogy.births(1)).sacrifice).to.equal(total);
      expect(await mug.balanceOf(treasury.address)).to.equal(total);
      expect(await mug.balanceOf(dogy.target)).to.equal(0n);
    });

    it("new pricing applies to the next reroll, continuing from the Dogy's own count", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, alice } = ctx;
      await approveAndReroll(ctx, alice, 1, T.Core);
      await approveAndReroll(ctx, alice, 1, T.Core);
      await dogy.setRerollPricing(E(10), E(5)); // 3rd reroll = 10 + 5 * 2
      expect(await dogy.nextRerollCost(1, T.Core)).to.equal(E(20));
      expect(await dogy.nextRerollCost(1, T.Power)).to.equal(E(10));
    });

    it("only the current owner can reroll (not others, not approved operators)", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, mug, alice, bob } = ctx;
      await mug.connect(bob).approve(dogy, E(100));
      await expect(dogy.connect(bob).reroll(1, T.Core)).to.be.revertedWithCustomError(dogy, "NotDogyOwner").withArgs(1, bob.address);
      await dogy.connect(alice).approve(bob.address, 1);
      await dogy.connect(alice).setApprovalForAll(bob.address, true);
      await expect(dogy.connect(bob).reroll(1, T.Core)).to.be.revertedWithCustomError(dogy, "NotDogyOwner").withArgs(1, bob.address);

      // After a transfer the new owner rerolls; the old owner can not. Count carries over.
      await approveAndReroll(ctx, alice, 1, T.Core);
      await dogy.connect(alice).transferFrom(alice.address, bob.address, 1);
      await expect(dogy.connect(alice).reroll(1, T.Core)).to.be.revertedWithCustomError(dogy, "NotDogyOwner").withArgs(1, alice.address);
      expect(await dogy.nextRerollCost(1, T.Core)).to.equal(E(3));
      await approveAndReroll(ctx, bob, 1, T.Core);
      expect((await dogy.births(1)).rerollCounts[T.Core]).to.equal(2n);
    });

    it("reverts for a bad table, a missing Dogy, while paused, or without MUG approval", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, mug, alice } = ctx;
      await expect(dogy.connect(alice).reroll(1, 3)).to.be.revertedWithCustomError(dogy, "InvalidTable").withArgs(3);
      await expect(dogy.nextRerollCost(1, 3)).to.be.revertedWithCustomError(dogy, "InvalidTable").withArgs(3);
      await expect(dogy.connect(alice).reroll(2, T.Core)).to.be.revertedWithCustomError(dogy, "ERC721NonexistentToken").withArgs(2);
      await expect(dogy.nextRerollCost(2, T.Core)).to.be.revertedWithCustomError(dogy, "ERC721NonexistentToken").withArgs(2);

      const before = await dogy.births(1);
      await expect(dogy.connect(alice).reroll(1, T.Core))
        .to.be.revertedWithCustomError(mug, "ERC20InsufficientAllowance")
        .withArgs(dogy.target, 0, E(2));

      await mug.connect(alice).approve(dogy, E(2));
      await dogy.pause();
      await expect(dogy.connect(alice).reroll(1, T.Core)).to.be.revertedWithCustomError(dogy, "EnforcedPause");
      const after = await dogy.births(1);
      expect(after.seeds[T.Core]).to.equal(before.seeds[T.Core]);
      expect(after.rerollCounts[T.Core]).to.equal(0n);
      expect(after.sacrifice).to.equal(PRICE);
    });

    it("setRerollPricing is owner-only and sets the base and the step", async function () {
      const { dogy, bob } = await loadFixture(deployFixture);
      await expect(dogy.connect(bob).setRerollPricing(1, STEP))
        .to.be.revertedWithCustomError(dogy, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);
      await expect(dogy.setRerollPricing(E(3), E(2))).to.emit(dogy, "RerollPricingSet").withArgs(E(3), E(2));
      expect(await dogy.rerollBase()).to.equal(E(3));
      expect(await dogy.rerollStep()).to.equal(E(2));
    });
  });

  describe("lock (the UI's 'Mint Dogy')", function () {
    it("names the Dogy, freezes every table and emits Locked(id, name, seeds)", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, alice } = ctx;
      await approveAndReroll(ctx, alice, 1, T.Power);
      const seeds = [...(await dogy.births(1)).seeds];

      const tx = dogy.connect(alice).lock(1, "Halfy");
      await expect(tx).to.emit(dogy, "Locked").withArgs(1, "Halfy", seeds);
      await expect(tx).to.emit(dogy, "MetadataUpdate").withArgs(1);

      const b = await dogy.births(1);
      expect(b.locked).to.equal(true);
      expect(b.name).to.equal("Halfy");
      expect([...b.seeds]).to.deep.equal(seeds);
      expect([...b.rerollCounts]).to.deep.equal([0n, 1n, 0n]);
      expect(b.sacrifice).to.equal(PRICE + E(2));
    });

    it("no reroll of any table after lock, and no second lock", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, mug, alice } = ctx;
      await dogy.connect(alice).lock(1, "Prime");
      await mug.connect(alice).approve(dogy, E(100));
      for (const t of [T.Core, T.Power, T.Traits]) {
        await expect(dogy.connect(alice).reroll(1, t)).to.be.revertedWithCustomError(dogy, "DogyLocked").withArgs(1);
      }
      await expect(dogy.connect(alice).lock(1, "Again")).to.be.revertedWithCustomError(dogy, "DogyLocked").withArgs(1);
      expect((await dogy.births(1)).name).to.equal("Prime");
      // nextRerollCost still reports the formula price; `locked` is the source of truth.
      expect(await dogy.nextRerollCost(1, T.Core)).to.equal(E(2));
    });

    it("validates the name: 1-32 bytes of UTF-8", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, alice } = ctx;
      await expect(dogy.connect(alice).lock(1, "")).to.be.revertedWithCustomError(dogy, "InvalidName").withArgs(0);
      await expect(dogy.connect(alice).lock(1, "x".repeat(33))).to.be.revertedWithCustomError(dogy, "InvalidName").withArgs(33);
      // Limit is bytes, not characters: each dog emoji is 4 bytes.
      await expect(dogy.connect(alice).lock(1, "\u{1F436}".repeat(9))).to.be.revertedWithCustomError(dogy, "InvalidName").withArgs(36);
      await dogy.connect(alice).lock(1, "\u{1F436}".repeat(8));
      expect((await dogy.births(1)).name).to.equal("\u{1F436}".repeat(8));

      await birth(ctx, alice, 0);
      await dogy.connect(alice).lock(2, "y".repeat(32));
      expect((await dogy.births(2)).name).to.equal("y".repeat(32));
      await birth(ctx, alice, 1);
      await dogy.connect(alice).lock(3, "A");
      expect((await dogy.births(3)).name).to.equal("A");
    });

    it("only the current owner can lock; it works while paused; locked Dogys still transfer", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, alice, bob, owner } = ctx;
      await expect(dogy.connect(bob).lock(1, "Mine")).to.be.revertedWithCustomError(dogy, "NotDogyOwner").withArgs(1, bob.address);
      await expect(dogy.connect(owner).lock(1, "Mine")).to.be.revertedWithCustomError(dogy, "NotDogyOwner").withArgs(1, owner.address);
      await expect(dogy.connect(alice).lock(9, "Nope")).to.be.revertedWithCustomError(dogy, "ERC721NonexistentToken").withArgs(9);

      await dogy.pause();
      await dogy.connect(alice).lock(1, "Spartacus");
      expect((await dogy.births(1)).locked).to.equal(true);
      await dogy.connect(alice).transferFrom(alice.address, bob.address, 1);
      expect(await dogy.ownerOf(1)).to.equal(bob.address);
      expect((await dogy.births(1)).name).to.equal("Spartacus");
    });
  });

  describe("metadata", function () {
    it("tokenURI = baseURI + id; reverts for ids that do not exist", async function () {
      const ctx = await loadFixture(deployFixture);
      for (const p of [0, 1, 2]) await birth(ctx, ctx.alice, p);
      expect(await ctx.dogy.tokenURI(1)).to.equal("https://new.mu.money/nft/mu-dogy/1");
      expect(await ctx.dogy.tokenURI(3)).to.equal("https://new.mu.money/nft/mu-dogy/3");
      await expect(ctx.dogy.tokenURI(0)).to.be.revertedWithCustomError(ctx.dogy, "ERC721NonexistentToken").withArgs(0);
      await expect(ctx.dogy.tokenURI(4)).to.be.revertedWithCustomError(ctx.dogy, "ERC721NonexistentToken").withArgs(4);
      await expect(ctx.dogy.births(4)).to.be.revertedWithCustomError(ctx.dogy, "ERC721NonexistentToken").withArgs(4);
    });

    it("setBaseURI changes every URI and signals a refresh (ERC-4906)", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.dogy.setBaseURI("https://a.example/")).to.emit(ctx.dogy, "BaseURISet").and.not.to.emit(ctx.dogy, "BatchMetadataUpdate");
      for (const p of [0, 1]) await birth(ctx, ctx.alice, p);
      await expect(ctx.dogy.setBaseURI("https://b.example/dogy/"))
        .to.emit(ctx.dogy, "BatchMetadataUpdate")
        .withArgs(1, 2);
      expect(await ctx.dogy.tokenURI(2)).to.equal("https://b.example/dogy/2");
      await expect(ctx.dogy.refreshMetadata(1, 2)).to.emit(ctx.dogy, "BatchMetadataUpdate").withArgs(1, 2);
    });
  });

  describe("royalties (ERC-2981)", function () {
    it("none by default; owner sets, caps at 10% and can remove", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, treasury, bob } = ctx;
      let [receiver, amount] = await dogy.royaltyInfo(1, E(100));
      expect(receiver).to.equal(ZERO);
      expect(amount).to.equal(0n);

      await expect(dogy.setRoyalty(treasury.address, 500)).to.emit(dogy, "RoyaltySet").withArgs(treasury.address, 500);
      [receiver, amount] = await dogy.royaltyInfo(1, E(100));
      expect(receiver).to.equal(treasury.address);
      expect(amount).to.equal(E(5));

      await expect(dogy.setRoyalty(treasury.address, 1001)).to.be.revertedWithCustomError(dogy, "RoyaltyTooHigh").withArgs(1001, 1000);
      await dogy.setRoyalty(bob.address, 1000);
      [receiver, amount] = await dogy.royaltyInfo(1, E(100));
      expect(receiver).to.equal(bob.address);
      expect(amount).to.equal(E(10));

      await expect(dogy.setRoyalty(ZERO, 0)).to.emit(dogy, "RoyaltySet").withArgs(ZERO, 0);
      [receiver, amount] = await dogy.royaltyInfo(1, E(100));
      expect(receiver).to.equal(ZERO);
      expect(amount).to.equal(0n);
    });
  });

  describe("admin", function () {
    it("every admin function is owner-only", async function () {
      const ctx = await loadFixture(bornFixture);
      const d = ctx.dogy.connect(ctx.bob);
      const calls = [
        () => d.setPrice(1),
        () => d.setTreasury(ctx.bob.address),
        () => d.setRerollPricing(1, STEP),
        () => d.setBaseURI("x"),
        () => d.refreshMetadata(1, 1),
        () => d.pause(),
        () => d.unpause(),
        () => d.setBlocked(1, true),
        () => d.setRoyalty(ctx.bob.address, 100),
        () => d.returnStrandedPup(0, ctx.bob.address),
        () => d.renounceOwnership(),
      ];
      for (const call of calls) {
        await expect(call()).to.be.revertedWithCustomError(ctx.dogy, "OwnableUnauthorizedAccount").withArgs(ctx.bob.address);
      }
    });

    it("rejects a zero treasury", async function () {
      const { dogy } = await loadFixture(deployFixture);
      await expect(dogy.setTreasury(ZERO)).to.be.revertedWithCustomError(dogy, "ZeroAddress");
    });

    it("ownership moves in two steps", async function () {
      const { dogy, owner, newOwner, bob } = await loadFixture(deployFixture);
      await expect(dogy.transferOwnership(newOwner.address))
        .to.emit(dogy, "OwnershipTransferStarted")
        .withArgs(owner.address, newOwner.address);
      expect(await dogy.owner()).to.equal(owner.address);
      expect(await dogy.pendingOwner()).to.equal(newOwner.address);

      // Pending owner has no power yet; nobody else can accept.
      await expect(dogy.connect(newOwner).setPrice(1)).to.be.revertedWithCustomError(dogy, "OwnableUnauthorizedAccount");
      await expect(dogy.connect(bob).acceptOwnership())
        .to.be.revertedWithCustomError(dogy, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);

      await expect(dogy.connect(newOwner).acceptOwnership())
        .to.emit(dogy, "OwnershipTransferred")
        .withArgs(owner.address, newOwner.address);
      expect(await dogy.owner()).to.equal(newOwner.address);
      expect(await dogy.pendingOwner()).to.equal(ZERO);
      await expect(dogy.connect(owner).setPrice(1))
        .to.be.revertedWithCustomError(dogy, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
      await dogy.connect(newOwner).setPrice(1);
      expect(await dogy.price()).to.equal(1n);
    });
  });

  describe("no backdoors", function () {
    it("the owner can not move, reroll or lock a user's Dogy", async function () {
      const ctx = await loadFixture(bornFixture);
      const { dogy, owner, alice } = ctx;
      await expect(dogy.connect(owner).transferFrom(alice.address, owner.address, 1))
        .to.be.revertedWithCustomError(dogy, "ERC721InsufficientApproval")
        .withArgs(owner.address, 1);
      await expect(dogy.connect(owner).reroll(1, T.Core)).to.be.revertedWithCustomError(dogy, "NotDogyOwner");
      await expect(dogy.connect(owner).lock(1, "Owned")).to.be.revertedWithCustomError(dogy, "NotDogyOwner");
      expect(await dogy.ownerOf(1)).to.equal(alice.address);
    });

    it("exposes exactly the expected state-changing functions (no withdraw/sweep/admin transfer)", async function () {
      const { dogy } = await loadFixture(deployFixture);
      const mutating = dogy.interface.fragments
        .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f) => f.format("sighash"))
        .sort();
      expect(mutating).to.deep.equal(
        [
          "acceptOwnership()",
          "approve(address,uint256)",
          "lock(uint256,string)",
          "onERC721Received(address,address,uint256,bytes)",
          "pause()",
          "refreshMetadata(uint256,uint256)",
          "renounceOwnership()",
          "reroll(uint256,uint8)",
          "returnStrandedPup(uint256,address)",
          "safeTransferFrom(address,address,uint256)",
          "safeTransferFrom(address,address,uint256,bytes)",
          "setApprovalForAll(address,bool)",
          "setBaseURI(string)",
          "setBlocked(uint256,bool)",
          "setPrice(uint256)",
          "setRerollPricing(uint256,uint256)",
          "setRoyalty(address,uint96)",
          "setTreasury(address)",
          "transferFrom(address,address,uint256)",
          "transferOwnership(address)",
          "unpause()",
        ].sort(),
      );
      expect(mutating.some((s) => /payable|withdraw|sweep|rescueERC20/i.test(s))).to.equal(false);
    });

    it("never holds MUG: births and rerolls pay the treasury directly", async function () {
      const ctx = await loadFixture(deployFixture);
      for (const p of [0, 1, 2]) await birth(ctx, ctx.alice, p);
      for (const t of [T.Core, T.Power, T.Traits, T.Core]) await approveAndReroll(ctx, ctx.alice, 2, t);
      expect(await ctx.mug.balanceOf(ctx.dogy.target)).to.equal(0n);
      expect(await ctx.mug.balanceOf(ctx.treasury.address)).to.equal(PRICE * 3n + E(2) * 3n + E(3));
    });
  });

  describe("reentrancy", function () {
    async function reentrantFixture() {
      const ctx = await deployFixture();
      const rMug = await (await ethers.getContractFactory("ReentrantMUG")).deploy();
      const dogy2 = await ctx.Dogy.deploy(
        ctx.owner.address, ctx.pups, rMug, ctx.muo, ctx.muv, ctx.treasury.address, PRICE, REROLL_BASE, STEP, "",
      );
      await rMug.mint(ctx.alice.address, E(1000));
      await rMug.connect(ctx.alice).approve(dogy2, ethers.MaxUint256);
      await ctx.pups.mintId(rMug.target, 200); // the attacker token owns a Pup
      const guardErr = dogy2.interface.getError("ReentrancyGuardReentrantCall").selector;
      return { ...ctx, rMug, dogy2, guardErr };
    }
    const BirthMode = 1;
    const RerollMode = 2;

    it("a malicious payment token can not start a nested birth during a birth", async function () {
      const { pups, alice, rMug, dogy2, guardErr } = await loadFixture(reentrantFixture);
      await rMug.arm(pups, dogy2, 200, BirthMode);
      await pups.connect(alice)[SAFE](alice.address, dogy2, 0);
      expect(await rMug.attempted()).to.equal(true);
      expect(await rMug.reentrySucceeded()).to.equal(false);
      expect(await rMug.reentryError()).to.equal(guardErr);
      expect(await pups.ownerOf(200)).to.equal(rMug.target);
      expect(await dogy2.totalSupply()).to.equal(1n);
      expect(await dogy2.ownerOf(1)).to.equal(alice.address);
    });

    it("a malicious payment token can not reroll during a birth, or birth during a reroll", async function () {
      const { pups, alice, rMug, dogy2, guardErr } = await loadFixture(reentrantFixture);
      await pups.connect(alice)[SAFE](alice.address, dogy2, 0); // Dogy #1, unarmed

      await rMug.arm(pups, dogy2, 1, RerollMode); // tries dogy2.reroll(1, Core) mid-birth
      await pups.connect(alice)[SAFE](alice.address, dogy2, 1);
      expect(await rMug.reentrySucceeded()).to.equal(false);
      expect(await rMug.reentryError()).to.equal(guardErr);
      expect((await dogy2.births(1)).rerollCounts[0]).to.equal(0n);

      await rMug.arm(pups, dogy2, 200, BirthMode); // tries a birth mid-reroll
      await dogy2.connect(alice).reroll(1, T.Power);
      expect(await rMug.reentrySucceeded()).to.equal(false);
      expect(await rMug.reentryError()).to.equal(guardErr);
      expect(await dogy2.totalSupply()).to.equal(2n);
      expect((await dogy2.births(1)).rerollCounts[1]).to.equal(1n);
    });

    it("a contract holder can not re-enter from the Dogy mint callback", async function () {
      const ctx = await loadFixture(deployFixture);
      const holder = await (await ethers.getContractFactory("ContractHolder")).deploy(ctx.pups, ctx.dogy);
      await ctx.pups.mintId(holder.target, 210);
      await ctx.pups.mintId(holder.target, 211);
      await ctx.mug.mint(holder.target, E(100));
      await holder.approveToken(ctx.mug, ctx.dogy, E(100));
      await holder.setMode(2, 211); // ReenterBirth with Pup #211

      await holder.birth(210);
      expect(await holder.attempted()).to.equal(true);
      expect(await holder.reentrySucceeded()).to.equal(false);
      expect(await holder.reentryError()).to.equal(ctx.dogy.interface.getError("ReentrancyGuardReentrantCall").selector);
      expect(await ctx.dogy.ownerOf(1)).to.equal(holder.target);
      expect(await ctx.pups.ownerOf(211)).to.equal(holder.target);
      expect(await ctx.dogy.totalSupply()).to.equal(1n);
    });

    it("a recipient that rejects the Dogy rolls back the whole birth (Pup and MUG untouched)", async function () {
      const ctx = await loadFixture(deployFixture);
      const holder = await (await ethers.getContractFactory("ContractHolder")).deploy(ctx.pups, ctx.dogy);
      await ctx.pups.mintId(holder.target, 210);
      await ctx.mug.mint(holder.target, E(100));
      await holder.approveToken(ctx.mug, ctx.dogy, E(100));
      await holder.setMode(1, 0); // Reject

      await expect(holder.birth(210)).to.be.revertedWith("ContractHolder: rejecting Dogy");
      expect(await ctx.pups.ownerOf(210)).to.equal(holder.target);
      expect(await ctx.mug.balanceOf(holder.target)).to.equal(E(100));
      expect(await ctx.dogy.totalSupply()).to.equal(0n);
      expect(await ctx.dogy.dogyOfPup(210)).to.equal(0n);
    });
  });

  describe("known randomness limitation (documented, not fixed)", function () {
    it("a contract holder can revert rerolls it does not like and pays only for the ones it keeps", async function () {
      const ctx = await loadFixture(deployFixture);
      const { dogy, mug, pups, treasury } = ctx;
      const holder = await (await ethers.getContractFactory("ContractHolder")).deploy(pups, dogy);
      await pups.mintId(holder.target, 210);
      await mug.mint(holder.target, E(1000));
      await holder.approveToken(mug, dogy, ethers.MaxUint256);
      await holder.birth(210); // Dogy #1, mode Accept

      let kept = 0;
      let refused = 0;
      let paid = 0n;
      for (let i = 0; i < 64 && (kept === 0 || refused === 0); i++) {
        const cost = await dogy.nextRerollCost(1, T.Traits);
        try {
          await (await holder.rerollPicky(1, T.Traits)).wait();
          kept++;
          paid += cost;
        } catch (err) {
          expect(String(err.message)).to.include("OddSeed");
          refused++;
          await mine(1);
        }
      }
      expect(kept).to.be.greaterThan(0);
      expect(refused).to.be.greaterThan(0);
      const b = await dogy.births(1);
      expect(b.rerollCounts[T.Traits]).to.equal(BigInt(kept));
      expect(BigInt(b.seeds[T.Traits]) % 2n).to.equal(0n);
      expect(await mug.balanceOf(treasury.address)).to.equal(PRICE + paid);
    });

    it("a contract holder can also refuse a birth seed and retry later with the same Pup", async function () {
      const ctx = await loadFixture(deployFixture);
      const { dogy, mug, pups } = ctx;
      const holder = await (await ethers.getContractFactory("ContractHolder")).deploy(pups, dogy);
      await pups.mintId(holder.target, 210);
      await mug.mint(holder.target, E(100));
      await holder.approveToken(mug, dogy, ethers.MaxUint256);
      await holder.setMode(3, 0); // PickyEvenSeed

      let attempts = 0;
      for (; attempts < 64; attempts++) {
        try {
          await (await holder.birth(210)).wait();
          break;
        } catch (err) {
          expect(String(err.message)).to.include("OddSeed");
          expect(await pups.ownerOf(210)).to.equal(holder.target);
          await mine(1);
        }
      }
      expect(await dogy.ownerOf(1)).to.equal(holder.target);
      expect(BigInt((await dogy.births(1)).seeds[T.Core]) % 2n).to.equal(0n);
      expect(await mug.balanceOf(holder.target)).to.equal(E(100) - PRICE); // paid once, however many tries
    });
  });

  describe("gas", function () {
    it("birth, reroll and lock stay within budget", async function () {
      const ctx = await loadFixture(deployFixture);
      const birthRcpt = await (await birth(ctx, ctx.alice, 3)).wait();
      const { receipt: rerollRcpt } = await approveAndReroll(ctx, ctx.alice, 1, T.Core);
      const lockRcpt = await (await ctx.dogy.connect(ctx.alice).lock(1, "Gas Dog")).wait();
      console.log(
        `      gas: birth (safeTransferFrom incl. MUG pull, burn, mint) ${birthRcpt.gasUsed}, ` +
          `first reroll ${rerollRcpt.gasUsed}, lock ${lockRcpt.gasUsed}`,
      );
      expect(birthRcpt.gasUsed).to.be.lessThan(450000n);
      expect(rerollRcpt.gasUsed).to.be.lessThan(120000n);
      expect(lockRcpt.gasUsed).to.be.lessThan(100000n);
    });
  });
});
