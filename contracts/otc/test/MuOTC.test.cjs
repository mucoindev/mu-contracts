const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const MAX = ethers.MaxUint256;
const ONE = ethers.parseEther("1");
const FEE = ONE; // 1 MUG
const EXPORT_FILE = path.resolve(__dirname, "..", "..", "..", "release", "otc", "MuOTC.json");

const Kind = { ERC20: 0n, ERC721: 1n };
const Status = { None: 0n, Open: 1n, Filled: 2n, Cancelled: 3n };

const erc20 = (token, amount) => ({ kind: Kind.ERC20, token: token.target ?? token, amountOrId: amount });
const erc721 = (token, id) => ({ kind: Kind.ERC721, token: token.target ?? token, amountOrId: id });
const tuple = (a) => [a.kind, a.token, a.amountOrId];

async function deploy(name, ...args) {
  const F = await ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function fixture() {
  const [owner, alice, bob, carol, dave, feeSink, other] = await ethers.getSigners();

  const mug = await deploy("MockERC20", "Mu Gold", "MUG");
  const tka = await deploy("MockERC20", "Token A", "TKA");
  const usdc = await deploy("MockERC20Six", "USD Coin", "USDC");
  const fot = await deploy("FeeOnTransferERC20");
  const evil = await deploy("ReentrantERC20");
  const pup = await deploy("MockERC721", "MU Pup", "PUP");
  const art = await deploy("MockERC721", "Art", "ART");
  const safeNft = await deploy("SafeOnlyERC721");
  const broken = await deploy("BrokenERC721");

  const OTC = await ethers.getContractFactory("MuOTC");
  const otc = await OTC.deploy(mug.target, FEE, feeSink.address);
  await otc.waitForDeployment();

  for (const u of [alice, bob, carol, dave]) {
    await mug.mint(u.address, ethers.parseEther("1000"));
    await tka.mint(u.address, ethers.parseEther("1000"));
    await usdc.mint(u.address, 1_000_000n * 10n ** 6n);
    await fot.mint(u.address, ethers.parseEther("1000"));
    await evil.mint(u.address, ethers.parseEther("1000"));
    for (const t of [mug, tka, usdc, fot, evil]) await t.connect(u).approve(otc.target, MAX);
    for (const n of [pup, art, safeNft, broken]) await n.connect(u).setApprovalForAll(otc.target, true);
  }
  // alice: PUP 1,2,3 + SAFE 1 + BRK 1; bob: ART 10,11 + BRK 2; carol: PUP 5, ART 12
  for (const id of [1, 2, 3]) await pup.mint(alice.address, id);
  await pup.mint(carol.address, 5);
  await art.mint(bob.address, 10);
  await art.mint(bob.address, 11);
  await art.mint(carol.address, 12);
  await safeNft.mint(alice.address, 1);
  await broken.mint(alice.address, 1);
  await broken.mint(bob.address, 2);

  return { OTC, otc, mug, tka, usdc, fot, evil, pup, art, safeNft, broken, owner, alice, bob, carol, dave, feeSink, other };
}

/** createOrder and return the new id (read from the event). */
async function create(otc, signer, taker, give, get, expiresAt = 0n) {
  const tx = await otc.connect(signer).createOrder(taker, give, get, expiresAt);
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => otc.interface.parseLog(l)).find((l) => l && l.name === "OrderCreated");
  return { id: ev.args.id, tx, rc };
}

async function ids(promise) {
  const [i] = await promise;
  return i.map((x) => Number(x));
}

describe("MuOTC", function () {
  // ------------------------------------------------------------------ deployment

  describe("deployment", function () {
    it("sets fee, owner = deployer, unpaused, no orders, MAX_FEE = 100e18, emits FeeChanged", async function () {
      const { otc, mug, owner, feeSink } = await loadFixture(fixture);
      expect(await otc.feeToken()).to.equal(mug.target);
      expect(await otc.feeAmount()).to.equal(FEE);
      expect(await otc.feeRecipient()).to.equal(feeSink.address);
      expect(await otc.owner()).to.equal(owner.address);
      expect(await otc.pendingOwner()).to.equal(ZERO);
      expect(await otc.paused()).to.equal(false);
      expect(await otc.orderCount()).to.equal(0n);
      expect(await otc.openOrderCount()).to.equal(0n);
      expect(await otc.MAX_FEE()).to.equal(ethers.parseEther("100"));
      await expect(otc.deploymentTransaction()).to.emit(otc, "FeeChanged").withArgs(mug.target, FEE, feeSink.address);
    });

    it("constructor validates the fee like setFee", async function () {
      const { OTC, mug, feeSink, other } = await loadFixture(fixture);
      await expect(OTC.deploy(mug.target, ethers.parseEther("100") + 1n, feeSink.address))
        .to.be.revertedWithCustomError(OTC, "FeeTooHigh");
      await expect(OTC.deploy(other.address, FEE, feeSink.address))
        .to.be.revertedWithCustomError(OTC, "NotAContract").withArgs(other.address);
      // A disabled fee needs no token at all.
      const free = await OTC.deploy(ZERO, 0n, ZERO);
      expect(await free.feeAmount()).to.equal(0n);
    });

    it("runtime bytecode is identical for any constructor args and equals the exported hash", async function () {
      const { OTC, otc, tka, other } = await loadFixture(fixture);
      const art = await artifacts.readArtifact("MuOTC");
      const artHash = ethers.keccak256(art.deployedBytecode);

      const a = await OTC.deploy(tka.target, 5n, other.address);
      const b = await OTC.deploy(ZERO, 0n, ZERO);
      const hashes = await Promise.all(
        [otc, a, b].map(async (c) => ethers.keccak256(await ethers.provider.getCode(c.target))),
      );
      expect(hashes[0]).to.equal(artHash);
      expect(hashes[1]).to.equal(artHash);
      expect(hashes[2]).to.equal(artHash);
      expect(await a.feeToken()).to.not.equal(await otc.feeToken()); // args really differed

      expect(fs.existsSync(EXPORT_FILE), "run scripts/export-muotc.cjs first").to.equal(true);
      const exported = JSON.parse(fs.readFileSync(EXPORT_FILE, "utf8"));
      expect(exported.contractName).to.equal("MuOTC");
      expect(exported.deployedBytecodeHash).to.equal(artHash);
      expect(exported.deployedBytecode).to.equal(art.deployedBytecode);
      expect(exported.bytecode).to.equal(art.bytecode);
      expect(exported.abi).to.deep.equal(art.abi);
      expect(exported.compiler).to.deep.include({ optimizer: true, runs: 200, evmVersion: "cancun" });
      expect(exported.compiler.version).to.match(/^0\.8\.28\+commit\./);
      expect(exported.defaults).to.deep.equal({
        feeToken: "0xF7ed17f0Fb2B7C9D3DDBc9F0679b2e1098993e81",
        feeAmount: "1000000000000000000",
        feeRecipient: "0x12127E06c0A2C82368BFC9C5a05E86B24429838a",
      });
    });

    it("exposes exactly the agreed interface (no owner function can touch escrow)", async function () {
      const { otc } = await loadFixture(fixture);
      const fns = otc.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.format("sighash"))
        .sort();
      expect(fns).to.deep.equal(
        [
          "MAX_FEE()",
          "acceptOwnership()",
          "canFill(uint256,address)",
          "cancelOrder(uint256)",
          "createOrder(address,(uint8,address,uint256),(uint8,address,uint256),uint64)",
          "feeAmount()",
          "feeRecipient()",
          "feeToken()",
          "fillOrder(uint256)",
          "getMakerOrders(address,uint256,uint256)",
          "getOpenOrders(uint256,uint256)",
          "getOrder(uint256)",
          "getOrders(uint256[])",
          "getTakerOrders(address,uint256,uint256)",
          "makerOrderCount(address)",
          "onERC721Received(address,address,uint256,bytes)",
          "openOrderCount()",
          "orderCount()",
          "owner()",
          "paused()",
          "pendingOwner()",
          "renounceOwnership()",
          "setFee(address,uint256,address)",
          "setPaused(bool)",
          "takerOrderCount(address)",
          "transferOwnership(address)",
        ].sort(),
      );
      const events = otc.interface.fragments.filter((f) => f.type === "event").map((f) => f.format("sighash")).sort();
      expect(events).to.deep.equal(
        [
          "FeeChanged(address,uint256,address)",
          "OrderCancelled(uint256,address)",
          "OrderCreated(uint256,address,address,(uint8,address,uint256),(uint8,address,uint256),uint64)",
          "OrderFilled(uint256,address,address)",
          "OwnershipTransferStarted(address,address)",
          "OwnershipTransferred(address,address)",
          "Paused(bool)",
        ].sort(),
      );
      const payable = otc.interface.fragments.filter((f) => f.type === "function" && f.payable);
      expect(payable).to.have.length(0);
    });

    it("runtime code has no DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE or CREATE2", async function () {
      const art = await artifacts.readArtifact("MuOTC");
      const code = Buffer.from(art.deployedBytecode.slice(2), "hex");
      const end = code.length - 2 - code.readUInt16BE(code.length - 2); // strip CBOR metadata
      const banned = { 0xf4: "DELEGATECALL", 0xf2: "CALLCODE", 0xff: "SELFDESTRUCT", 0xf0: "CREATE", 0xf5: "CREATE2" };
      const found = [];
      for (let i = 0; i < end; i++) {
        const op = code[i];
        if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // skip PUSH data
        else if (banned[op]) found.push(banned[op]);
      }
      expect(found).to.deep.equal([]);
    });
  });

  // ------------------------------------------------------------------ create + fill, all four shapes

  describe("create and fill", function () {
    it("token -> token: escrows on create, pays fee, fills atomically, records taker", async function () {
      const { otc, mug, tka, usdc, alice, bob, feeSink } = await loadFixture(fixture);
      const give = erc20(tka, ethers.parseEther("100"));
      const get = erc20(usdc, 50n * 10n ** 6n);

      const id = await otc.connect(alice).createOrder.staticCall(ZERO, give, get, 0);
      expect(id).to.equal(1n);

      const aliceMug0 = await mug.balanceOf(alice.address);
      const sink0 = await mug.balanceOf(feeSink.address);
      const tx = otc.connect(alice).createOrder(ZERO, give, get, 0);
      await expect(tx)
        .to.emit(otc, "OrderCreated")
        .withArgs(1n, alice.address, ZERO, tuple(give), tuple(get), 0n);
      await expect(tx).to.changeTokenBalances(tka, [alice, otc], [-give.amountOrId, give.amountOrId]);
      expect(await mug.balanceOf(alice.address)).to.equal(aliceMug0 - FEE);
      expect(await mug.balanceOf(feeSink.address)).to.equal(sink0 + FEE);

      const created = await time.latest();
      let o = await otc.getOrder(1);
      expect(o.maker).to.equal(alice.address);
      expect(o.taker).to.equal(ZERO);
      expect(tuple(o.give)).to.deep.equal(tuple(give));
      expect(tuple(o.get)).to.deep.equal(tuple(get));
      expect(o.createdAt).to.equal(BigInt(created));
      expect(o.expiresAt).to.equal(0n);
      expect(o.closedAt).to.equal(0n);
      expect(o.status).to.equal(Status.Open);
      expect(await otc.orderCount()).to.equal(1n);
      expect(await otc.openOrderCount()).to.equal(1n);

      const fill = otc.connect(bob).fillOrder(1);
      await expect(fill).to.emit(otc, "OrderFilled").withArgs(1n, alice.address, bob.address);
      await expect(fill).to.changeTokenBalances(usdc, [bob, alice, otc], [-get.amountOrId, get.amountOrId, 0n]);
      await expect(fill).to.not.be.reverted;

      o = await otc.getOrder(1);
      expect(o.status).to.equal(Status.Filled);
      expect(o.taker).to.equal(bob.address);
      expect(o.closedAt).to.equal(BigInt(await time.latest()));
      expect(await tka.balanceOf(bob.address)).to.equal(ethers.parseEther("1100"));
      expect(await tka.balanceOf(otc.target)).to.equal(0n);
      expect(await otc.openOrderCount()).to.equal(0n);
      expect(await otc.takerOrderCount(bob.address)).to.equal(1n);
      // no fee on fill
      expect(await mug.balanceOf(feeSink.address)).to.equal(sink0 + FEE);
    });

    it("token -> NFT", async function () {
      const { otc, tka, pup, alice, carol } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc20(tka, ethers.parseEther("100")), erc721(pup, 5n));
      await expect(otc.connect(carol).fillOrder(id)).to.changeTokenBalances(
        tka,
        [carol, otc],
        [ethers.parseEther("100"), -ethers.parseEther("100")],
      );
      expect(await pup.ownerOf(5)).to.equal(alice.address);
      expect((await otc.getOrder(id)).taker).to.equal(carol.address);
    });

    it("NFT -> token", async function () {
      const { otc, tka, pup, alice, bob } = await loadFixture(fixture);
      const { id, tx } = await create(otc, alice, ZERO, erc721(pup, 1n), erc20(tka, ethers.parseEther("25")));
      await expect(tx).to.emit(pup, "Transfer").withArgs(alice.address, otc.target, 1n);
      expect(await pup.ownerOf(1)).to.equal(otc.target);
      await expect(otc.connect(bob).fillOrder(id)).to.changeTokenBalances(
        tka,
        [bob, alice],
        [-ethers.parseEther("25"), ethers.parseEther("25")],
      );
      expect(await pup.ownerOf(1)).to.equal(bob.address);
    });

    it("NFT -> NFT (and the get NFT goes straight to the maker, never via the contract)", async function () {
      const { otc, pup, art, alice, bob } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc721(pup, 2n), erc721(art, 10n));
      const fill = otc.connect(bob).fillOrder(id);
      await expect(fill).to.emit(art, "Transfer").withArgs(bob.address, alice.address, 10n);
      await expect(fill).to.emit(pup, "Transfer").withArgs(otc.target, bob.address, 2n);
      expect(await art.ownerOf(10)).to.equal(alice.address);
      expect(await pup.ownerOf(2)).to.equal(bob.address);
    });

    it("works with 6-decimal tokens on both sides", async function () {
      const { otc, usdc, tka, alice, bob } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc20(usdc, 1n), erc20(tka, 1n)); // smallest units
      expect(await usdc.balanceOf(otc.target)).to.equal(1n);
      await otc.connect(bob).fillOrder(id);
      expect(await usdc.balanceOf(bob.address)).to.equal(1_000_000n * 10n ** 6n + 1n);
    });

    it("accepts ERC-721 token id 0", async function () {
      const { otc, pup, tka, alice, bob } = await loadFixture(fixture);
      await pup.mint(alice.address, 0);
      const { id } = await create(otc, alice, ZERO, erc721(pup, 0n), erc20(tka, 1n));
      await otc.connect(bob).fillOrder(id);
      expect(await pup.ownerOf(0)).to.equal(bob.address);
    });

    it("escrows an NFT whose transferFrom calls the receiver hook", async function () {
      const { otc, safeNft, tka, alice, bob } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc721(safeNft, 1n), erc20(tka, 1n));
      expect(await safeNft.ownerOf(1)).to.equal(otc.target);
      await otc.connect(bob).fillOrder(id);
      expect(await safeNft.ownerOf(1)).to.equal(bob.address);
    });

    it("the same token can sit in many escrows without interference", async function () {
      const { otc, tka, mug, alice, bob, carol } = await loadFixture(fixture);
      const a = await create(otc, alice, ZERO, erc20(tka, 10n), erc20(mug, 1n));
      const b = await create(otc, bob, ZERO, erc20(tka, 20n), erc20(mug, 2n));
      expect(await tka.balanceOf(otc.target)).to.equal(30n);
      await otc.connect(carol).fillOrder(b.id);
      await otc.connect(alice).cancelOrder(a.id);
      expect(await tka.balanceOf(otc.target)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------ fee

  describe("fee", function () {
    it("is skipped when feeAmount is 0", async function () {
      const { otc, mug, tka, alice, feeSink, owner } = await loadFixture(fixture);
      await otc.connect(owner).setFee(mug.target, 0n, feeSink.address);
      await mug.connect(alice).approve(otc.target, 0n); // proves no fee pull is attempted
      const sink0 = await mug.balanceOf(feeSink.address);
      await create(otc, alice, ZERO, erc20(tka, 1n), erc20(tka, 2n));
      expect(await mug.balanceOf(feeSink.address)).to.equal(sink0);
    });

    it("is skipped when feeRecipient is the zero address", async function () {
      const { otc, mug, tka, alice, owner } = await loadFixture(fixture);
      await otc.connect(owner).setFee(mug.target, FEE, ZERO);
      await mug.connect(alice).approve(otc.target, 0n);
      const a0 = await mug.balanceOf(alice.address);
      await create(otc, alice, ZERO, erc20(tka, 1n), erc20(tka, 2n));
      expect(await mug.balanceOf(alice.address)).to.equal(a0);
    });

    it("giving the fee token itself needs approval for fee + amount", async function () {
      const { otc, mug, tka, alice, feeSink } = await loadFixture(fixture);
      const amount = ethers.parseEther("100");
      await mug.connect(alice).approve(otc.target, amount); // fee not covered
      await expect(otc.connect(alice).createOrder(ZERO, erc20(mug, amount), erc20(tka, 1n), 0))
        .to.be.revertedWithCustomError(mug, "ERC20InsufficientAllowance");

      await mug.connect(alice).approve(otc.target, amount + FEE);
      const tx = otc.connect(alice).createOrder(ZERO, erc20(mug, amount), erc20(tka, 1n), 0);
      await expect(tx).to.changeTokenBalances(mug, [alice, feeSink, otc], [-(amount + FEE), FEE, amount]);
      expect(await mug.allowance(alice.address, otc.target)).to.equal(0n);
    });

    it("reverts create when the maker has not approved the fee", async function () {
      const { otc, mug, tka, alice } = await loadFixture(fixture);
      await mug.connect(alice).approve(otc.target, 0n);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(tka, 1n), erc20(tka, 2n), 0))
        .to.be.revertedWithCustomError(mug, "ERC20InsufficientAllowance");
    });

    it("is not refunded on cancel", async function () {
      const { otc, mug, tka, alice, feeSink } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(tka, 2n));
      const sink = await mug.balanceOf(feeSink.address);
      await otc.connect(alice).cancelOrder(id);
      expect(await mug.balanceOf(feeSink.address)).to.equal(sink);
    });

    it("setFee: owner only, capped, validated, emits, applies to new orders only", async function () {
      const { otc, mug, tka, alice, bob, owner, feeSink, other } = await loadFixture(fixture);
      await expect(otc.connect(alice).setFee(mug.target, 0n, ZERO))
        .to.be.revertedWithCustomError(otc, "OwnableUnauthorizedAccount").withArgs(alice.address);
      await expect(otc.connect(owner).setFee(mug.target, ethers.parseEther("100") + 1n, feeSink.address))
        .to.be.revertedWithCustomError(otc, "FeeTooHigh").withArgs(ethers.parseEther("100") + 1n, ethers.parseEther("100"));
      await expect(otc.connect(owner).setFee(mug.target, FEE, otc.target))
        .to.be.revertedWithCustomError(otc, "InvalidFeeRecipient");
      await expect(otc.connect(owner).setFee(other.address, FEE, feeSink.address))
        .to.be.revertedWithCustomError(otc, "NotAContract").withArgs(other.address);
      // disabled fee: token is not checked
      await expect(otc.connect(owner).setFee(other.address, 0n, feeSink.address)).to.not.be.reverted;
      // exactly MAX_FEE is allowed
      await expect(otc.connect(owner).setFee(tka.target, ethers.parseEther("100"), bob.address))
        .to.emit(otc, "FeeChanged").withArgs(tka.target, ethers.parseEther("100"), bob.address);
      expect(await otc.feeToken()).to.equal(tka.target);
      expect(await otc.feeAmount()).to.equal(ethers.parseEther("100"));
      expect(await otc.feeRecipient()).to.equal(bob.address);

      const tx = otc.connect(alice).createOrder(ZERO, erc20(mug, 5n), erc20(mug, 6n), 0);
      await expect(tx).to.changeTokenBalances(tka, [alice, bob], [-ethers.parseEther("100"), ethers.parseEther("100")]);
    });
  });

  // ------------------------------------------------------------------ reserved orders / takers

  describe("reserved orders", function () {
    it("only the reserved taker can fill", async function () {
      const { otc, tka, mug, alice, bob, carol } = await loadFixture(fixture);
      const { id, tx } = await create(otc, alice, bob.address, erc20(tka, 10n), erc20(mug, 1n));
      await expect(tx).to.emit(otc, "OrderCreated").withArgs(id, alice.address, bob.address, [0n, tka.target, 10n], [0n, mug.target, 1n], 0n);
      await expect(otc.connect(carol).fillOrder(id)).to.be.revertedWithCustomError(otc, "ReservedForAnotherWallet");
      await expect(otc.connect(bob).fillOrder(id)).to.emit(otc, "OrderFilled").withArgs(id, alice.address, bob.address);
      expect((await otc.getOrder(id)).taker).to.equal(bob.address);
    });

    it("taker cannot be the maker or the contract", async function () {
      const { otc, tka, mug, alice } = await loadFixture(fixture);
      await expect(otc.connect(alice).createOrder(alice.address, erc20(tka, 1n), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "InvalidTaker");
      await expect(otc.connect(alice).createOrder(otc.target, erc20(tka, 1n), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "InvalidTaker");
    });

    it("the maker cannot fill their own order", async function () {
      const { otc, tka, mug, alice } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      await expect(otc.connect(alice).fillOrder(id)).to.be.revertedWithCustomError(otc, "MakerCannotFill");
    });
  });

  // ------------------------------------------------------------------ expiry

  describe("expiry", function () {
    it("rejects expiresAt in the past or equal to the block time", async function () {
      const { otc, tka, mug, alice } = await loadFixture(fixture);
      const now = BigInt(await time.latest());
      await expect(otc.connect(alice).createOrder(ZERO, erc20(tka, 1n), erc20(mug, 1n), now - 1n))
        .to.be.revertedWithCustomError(otc, "InvalidExpiry");
      await time.setNextBlockTimestamp(now + 10n);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(tka, 1n), erc20(mug, 1n), now + 10n))
        .to.be.revertedWithCustomError(otc, "InvalidExpiry");
      await time.setNextBlockTimestamp(now + 20n);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(tka, 1n), erc20(mug, 1n), now + 21n)).to.not.be.reverted;
    });

    it("can be filled until expiresAt - 1, not at or after expiresAt", async function () {
      const { otc, tka, mug, alice, bob, carol } = await loadFixture(fixture);
      const now = BigInt(await time.latest());
      const exp = now + 3600n;
      const a = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n), exp);
      const b = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n), exp);
      expect((await otc.getOrder(a.id)).expiresAt).to.equal(exp);

      await time.setNextBlockTimestamp(exp - 1n);
      await expect(otc.connect(bob).fillOrder(a.id)).to.not.be.reverted;

      await time.setNextBlockTimestamp(exp);
      await expect(otc.connect(carol).fillOrder(b.id)).to.be.revertedWithCustomError(otc, "OrderExpired").withArgs(b.id);
      await time.increase(86400);
      await expect(otc.connect(carol).fillOrder(b.id)).to.be.revertedWithCustomError(otc, "OrderExpired");
      const [ok, reason] = await otc.canFill(b.id, carol.address);
      expect(ok).to.equal(false);
      expect(reason).to.equal("expired");
    });

    it("an expired order can still be cancelled to reclaim the escrow", async function () {
      const { otc, tka, pup, mug, alice } = await loadFixture(fixture);
      const exp = BigInt(await time.latest()) + 60n;
      const a = await create(otc, alice, ZERO, erc20(tka, 7n), erc20(mug, 1n), exp);
      const b = await create(otc, alice, ZERO, erc721(pup, 3n), erc20(mug, 1n), exp);
      await time.increaseTo(exp + 1000n);
      expect(await otc.openOrderCount()).to.equal(2n); // still Open until cancelled
      await expect(otc.connect(alice).cancelOrder(a.id)).to.changeTokenBalances(tka, [alice, otc], [7n, -7n]);
      await otc.connect(alice).cancelOrder(b.id);
      expect(await pup.ownerOf(3)).to.equal(alice.address);
      expect(await otc.openOrderCount()).to.equal(0n);
    });

    it("expiresAt = 0 never expires", async function () {
      const { otc, tka, mug, alice, bob } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n), 0n);
      await time.increase(10 * 365 * 86400);
      await expect(otc.connect(bob).fillOrder(id)).to.not.be.reverted;
    });
  });

  // ------------------------------------------------------------------ cancel / double actions

  describe("cancel and terminal states", function () {
    it("cancel refunds an ERC-20 escrow and emits", async function () {
      const { otc, tka, mug, alice } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc20(tka, 42n), erc20(mug, 1n));
      const tx = otc.connect(alice).cancelOrder(id);
      await expect(tx).to.emit(otc, "OrderCancelled").withArgs(id, alice.address);
      await expect(tx).to.changeTokenBalances(tka, [alice, otc], [42n, -42n]);
      const o = await otc.getOrder(id);
      expect(o.status).to.equal(Status.Cancelled);
      expect(o.closedAt).to.equal(BigInt(await time.latest()));
      expect(o.taker).to.equal(ZERO);
      expect(await otc.openOrderCount()).to.equal(0n);
    });

    it("cancel refunds an ERC-721 escrow", async function () {
      const { otc, pup, art, alice } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc721(pup, 1n), erc721(art, 11n));
      expect(await pup.ownerOf(1)).to.equal(otc.target);
      await expect(otc.connect(alice).cancelOrder(id)).to.emit(pup, "Transfer").withArgs(otc.target, alice.address, 1n);
      expect(await pup.ownerOf(1)).to.equal(alice.address);
    });

    it("only the maker can cancel", async function () {
      const { otc, tka, mug, alice, bob, owner } = await loadFixture(fixture);
      const { id } = await create(otc, alice, bob.address, erc20(tka, 1n), erc20(mug, 1n));
      await expect(otc.connect(bob).cancelOrder(id)).to.be.revertedWithCustomError(otc, "NotMaker");
      await expect(otc.connect(owner).cancelOrder(id)).to.be.revertedWithCustomError(otc, "NotMaker");
    });

    it("double fill, double cancel, fill after cancel, cancel after fill, unknown ids all revert", async function () {
      const { otc, tka, mug, alice, bob, carol } = await loadFixture(fixture);
      const a = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      const b = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      await otc.connect(bob).fillOrder(a.id);
      await expect(otc.connect(carol).fillOrder(a.id)).to.be.revertedWithCustomError(otc, "OrderNotOpen").withArgs(a.id);
      await expect(otc.connect(bob).fillOrder(a.id)).to.be.revertedWithCustomError(otc, "OrderNotOpen");
      await expect(otc.connect(alice).cancelOrder(a.id)).to.be.revertedWithCustomError(otc, "OrderNotOpen");
      await otc.connect(alice).cancelOrder(b.id);
      await expect(otc.connect(alice).cancelOrder(b.id)).to.be.revertedWithCustomError(otc, "OrderNotOpen");
      await expect(otc.connect(bob).fillOrder(b.id)).to.be.revertedWithCustomError(otc, "OrderNotOpen");
      for (const bad of [0n, 3n, 999n]) {
        await expect(otc.connect(bob).fillOrder(bad)).to.be.revertedWithCustomError(otc, "OrderNotOpen").withArgs(bad);
        await expect(otc.connect(alice).cancelOrder(bad)).to.be.revertedWithCustomError(otc, "OrderNotOpen");
      }
    });

    it("a failed fill leaves everything untouched", async function () {
      const { otc, tka, art, alice, bob } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc20(tka, 5n), erc721(art, 12n)); // carol owns ART 12
      await expect(otc.connect(bob).fillOrder(id)).to.be.revertedWithCustomError(art, "ERC721IncorrectOwner");
      const o = await otc.getOrder(id);
      expect(o.status).to.equal(Status.Open);
      expect(o.taker).to.equal(ZERO);
      expect(await otc.openOrderCount()).to.equal(1n);
      expect(await otc.takerOrderCount(bob.address)).to.equal(0n);
      expect(await tka.balanceOf(otc.target)).to.equal(5n);
    });
  });

  // ------------------------------------------------------------------ token validation

  describe("asset validation", function () {
    it("rejects fee-on-transfer tokens on the give side (create)", async function () {
      const { otc, fot, mug, alice } = await loadFixture(fixture);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(fot, ethers.parseEther("100")), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "FeeOnTransferNotSupported").withArgs(fot.target);
      expect(await fot.balanceOf(otc.target)).to.equal(0n);
      expect(await otc.orderCount()).to.equal(0n);
    });

    it("rejects fee-on-transfer tokens on the get side (fill); the maker can still cancel", async function () {
      const { otc, fot, tka, alice, bob } = await loadFixture(fixture);
      const { id } = await create(otc, alice, ZERO, erc20(tka, 10n), erc20(fot, ethers.parseEther("1")));
      await expect(otc.connect(bob).fillOrder(id))
        .to.be.revertedWithCustomError(otc, "FeeOnTransferNotSupported").withArgs(fot.target);
      expect((await otc.getOrder(id)).status).to.equal(Status.Open);
      await expect(otc.connect(alice).cancelOrder(id)).to.changeTokenBalance(tka, alice, 10n);
    });

    it("rejects a non-ERC-721 address declared as ERC721 (give and get)", async function () {
      const { otc, tka, mug, pup, alice } = await loadFixture(fixture);
      await expect(otc.connect(alice).createOrder(ZERO, erc721(tka, 1n), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "NotAnERC721").withArgs(tka.target);
      await expect(otc.connect(alice).createOrder(ZERO, erc721(pup, 1n), erc721(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "NotAnERC721").withArgs(mug.target);
    });

    it("rejects an ERC-721 declared as ERC20 (it could never leave escrow)", async function () {
      const { otc, mug, pup, alice } = await loadFixture(fixture);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(pup, 1n), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "NotAnERC20").withArgs(pup.target);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(mug, 1n), erc20(pup, 1n), 0))
        .to.be.revertedWithCustomError(otc, "NotAnERC20").withArgs(pup.target);
    });

    it("rejects an EOA as token (give and get)", async function () {
      const { otc, mug, alice, other } = await loadFixture(fixture);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(other.address, 1n), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "NotAContract").withArgs(other.address);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(mug, 1n), erc721(other.address, 1n), 0))
        .to.be.revertedWithCustomError(otc, "NotAContract").withArgs(other.address);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(ZERO, 1n), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "NotAContract").withArgs(ZERO);
    });

    it("rejects a zero ERC-20 amount (give and get)", async function () {
      const { otc, mug, tka, alice } = await loadFixture(fixture);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(tka, 0n), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "ZeroAmount");
      await expect(otc.connect(alice).createOrder(ZERO, erc20(tka, 1n), erc20(mug, 0n), 0))
        .to.be.revertedWithCustomError(otc, "ZeroAmount");
    });

    it("rejects an out-of-range Kind", async function () {
      const { otc, mug, tka, alice } = await loadFixture(fixture);
      await expect(otc.connect(alice).createOrder(ZERO, { kind: 2, token: tka.target, amountOrId: 1n }, erc20(mug, 1n), 0))
        .to.be.reverted;
    });

    it("catches an NFT transfer that silently does nothing (escrow and fill)", async function () {
      const { otc, broken, tka, alice, bob } = await loadFixture(fixture);
      await broken.setBroken(true);
      await expect(otc.connect(alice).createOrder(ZERO, erc721(broken, 1n), erc20(tka, 1n), 0))
        .to.be.revertedWithCustomError(otc, "ERC721TransferFailed").withArgs(broken.target, 1n);
      const { id } = await create(otc, alice, ZERO, erc20(tka, 3n), erc721(broken, 2n));
      await expect(otc.connect(bob).fillOrder(id))
        .to.be.revertedWithCustomError(otc, "ERC721TransferFailed").withArgs(broken.target, 2n);
    });

    it("rejects NFTs pushed in directly with safeTransferFrom (they would be locked forever)", async function () {
      const { otc, pup, alice } = await loadFixture(fixture);
      await expect(pup.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, otc.target, 1n))
        .to.be.revertedWithCustomError(otc, "UnsolicitedERC721");
      await expect(otc.onERC721Received(alice.address, alice.address, 1n, "0x"))
        .to.be.revertedWithCustomError(otc, "UnsolicitedERC721");
      expect(await pup.ownerOf(1)).to.equal(alice.address);
    });
  });

  // ------------------------------------------------------------------ pause + owner

  describe("pause and ownership", function () {
    it("pause blocks createOrder only; fill and cancel keep working", async function () {
      const { otc, tka, mug, alice, bob, owner } = await loadFixture(fixture);
      const a = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      const b = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      await expect(otc.connect(alice).setPaused(true))
        .to.be.revertedWithCustomError(otc, "OwnableUnauthorizedAccount");
      await expect(otc.connect(owner).setPaused(true)).to.emit(otc, "Paused").withArgs(true);
      expect(await otc.paused()).to.equal(true);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(tka, 1n), erc20(mug, 1n), 0))
        .to.be.revertedWithCustomError(otc, "OrdersPaused");
      await expect(otc.connect(bob).fillOrder(a.id)).to.not.be.reverted;
      await expect(otc.connect(alice).cancelOrder(b.id)).to.not.be.reverted;
      await expect(otc.connect(owner).setPaused(false)).to.emit(otc, "Paused").withArgs(false);
      await expect(otc.connect(alice).createOrder(ZERO, erc20(tka, 1n), erc20(mug, 1n), 0)).to.not.be.reverted;
    });

    it("the owner cannot move escrow: every owner action leaves escrow balances untouched", async function () {
      const { otc, tka, pup, mug, alice, owner, bob } = await loadFixture(fixture);
      await create(otc, alice, ZERO, erc20(tka, 500n), erc20(mug, 1n));
      await create(otc, alice, ZERO, erc721(pup, 1n), erc20(mug, 1n));
      const before = await tka.balanceOf(otc.target);

      await otc.connect(owner).setFee(tka.target, ethers.parseEther("100"), owner.address);
      await otc.connect(owner).setPaused(true);
      await otc.connect(owner).setFee(ZERO, 0n, ZERO);
      await otc.connect(owner).setPaused(false);
      await otc.connect(owner).transferOwnership(bob.address);
      await otc.connect(bob).acceptOwnership();
      await otc.connect(bob).renounceOwnership();

      expect(await tka.balanceOf(otc.target)).to.equal(before);
      expect(await pup.ownerOf(1)).to.equal(otc.target);
      // escrow is still claimable by the maker after the owner is gone
      await otc.connect(alice).cancelOrder(1);
      await otc.connect(alice).cancelOrder(2);
      expect(await pup.ownerOf(1)).to.equal(alice.address);
      expect(await tka.balanceOf(otc.target)).to.equal(0n);
    });

    it("ownership transfer is two-step", async function () {
      const { otc, mug, owner, bob, carol } = await loadFixture(fixture);
      await expect(otc.connect(owner).transferOwnership(bob.address))
        .to.emit(otc, "OwnershipTransferStarted").withArgs(owner.address, bob.address);
      expect(await otc.owner()).to.equal(owner.address);
      expect(await otc.pendingOwner()).to.equal(bob.address);
      await expect(otc.connect(bob).setPaused(true)).to.be.revertedWithCustomError(otc, "OwnableUnauthorizedAccount");
      await expect(otc.connect(carol).acceptOwnership())
        .to.be.revertedWithCustomError(otc, "OwnableUnauthorizedAccount").withArgs(carol.address);
      await expect(otc.connect(bob).acceptOwnership())
        .to.emit(otc, "OwnershipTransferred").withArgs(owner.address, bob.address);
      expect(await otc.owner()).to.equal(bob.address);
      expect(await otc.pendingOwner()).to.equal(ZERO);
      await expect(otc.connect(owner).setFee(mug.target, 0n, ZERO)).to.be.revertedWithCustomError(otc, "OwnableUnauthorizedAccount");
      await expect(otc.connect(bob).setFee(mug.target, 0n, ZERO)).to.not.be.reverted;
    });
  });

  // ------------------------------------------------------------------ views, indexes, pagination

  describe("views and pagination", function () {
    async function fiveOrders() {
      const f = await loadFixture(fixture);
      const { otc, tka, mug, alice, bob } = f;
      for (let i = 1; i <= 5; i++) {
        const maker = i === 3 ? bob : alice;
        await create(otc, maker, ZERO, erc20(tka, BigInt(i)), erc20(mug, 1n));
      }
      return f;
    }

    it("getOpenOrders pages correctly and never reverts", async function () {
      const { otc } = await fiveOrders();
      expect(await otc.openOrderCount()).to.equal(5n);
      expect(await ids(otc.getOpenOrders(0, 10))).to.deep.equal([1, 2, 3, 4, 5]);
      expect(await ids(otc.getOpenOrders(0, 2))).to.deep.equal([1, 2]);
      expect(await ids(otc.getOpenOrders(2, 2))).to.deep.equal([3, 4]);
      expect(await ids(otc.getOpenOrders(4, 10))).to.deep.equal([5]);
      expect(await ids(otc.getOpenOrders(5, 10))).to.deep.equal([]);
      expect(await ids(otc.getOpenOrders(100, 10))).to.deep.equal([]);
      expect(await ids(otc.getOpenOrders(0, 0))).to.deep.equal([]);
      expect(await ids(otc.getOpenOrders(0, MAX))).to.deep.equal([1, 2, 3, 4, 5]);
      expect(await ids(otc.getOpenOrders(MAX, MAX))).to.deep.equal([]);
      const [i, orders] = await otc.getOpenOrders(1, 2);
      expect(orders.length).to.equal(i.length);
      expect(orders[0].give.amountOrId).to.equal(2n);
      expect(orders[1].maker).to.equal((await otc.getOrder(3)).maker);
    });

    it("swap-and-pop keeps the open set exact through removals in the middle, front and back", async function () {
      const { otc, alice, bob, carol, tka, mug } = await fiveOrders();
      await otc.connect(alice).cancelOrder(2); // middle: last (5) moves into its slot
      expect(await ids(otc.getOpenOrders(0, 10))).to.deep.equal([1, 5, 3, 4]);
      await otc.connect(carol).fillOrder(1); // front: last (4) moves into slot 0
      expect(await ids(otc.getOpenOrders(0, 10))).to.deep.equal([4, 5, 3]);
      await otc.connect(bob).cancelOrder(3); // back
      expect(await ids(otc.getOpenOrders(0, 10))).to.deep.equal([4, 5]);
      expect(await otc.openOrderCount()).to.equal(2n);
      await otc.connect(carol).fillOrder(5);
      await otc.connect(alice).cancelOrder(4);
      expect(await ids(otc.getOpenOrders(0, 10))).to.deep.equal([]);
      expect(await otc.openOrderCount()).to.equal(0n);
      // the set still works after being emptied
      await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      expect(await ids(otc.getOpenOrders(0, 10))).to.deep.equal([6]);
      const [, open] = await otc.getOpenOrders(0, 10);
      expect(open.every((o) => o.status === Status.Open)).to.equal(true);
    });

    it("a randomised sequence of removals keeps the open set equal to the Open orders", async function () {
      const { otc, tka, mug, alice, carol } = await loadFixture(fixture);
      const N = 24;
      for (let i = 0; i < N; i++) await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      let seed = 12345;
      const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
      const open = new Set(Array.from({ length: N }, (_, i) => i + 1));
      while (open.size > 3) {
        const arr = [...open];
        const id = arr[rnd(arr.length)];
        if (rnd(2)) await otc.connect(alice).cancelOrder(id);
        else await otc.connect(carol).fillOrder(id);
        open.delete(id);
        const listed = (await ids(otc.getOpenOrders(0, 1000))).sort((a, b) => a - b);
        expect(listed).to.deep.equal([...open].sort((a, b) => a - b));
      }
    });

    it("maker index lists every order by its maker, oldest first, any status", async function () {
      const { otc, alice, bob, carol } = await fiveOrders();
      await otc.connect(carol).fillOrder(2);
      await otc.connect(alice).cancelOrder(4);
      expect(await otc.makerOrderCount(alice.address)).to.equal(4n);
      expect(await otc.makerOrderCount(bob.address)).to.equal(1n);
      expect(await otc.makerOrderCount(carol.address)).to.equal(0n);
      expect(await ids(otc.getMakerOrders(alice.address, 0, 10))).to.deep.equal([1, 2, 4, 5]);
      expect(await ids(otc.getMakerOrders(alice.address, 1, 2))).to.deep.equal([2, 4]);
      expect(await ids(otc.getMakerOrders(alice.address, 4, 2))).to.deep.equal([]);
      expect(await ids(otc.getMakerOrders(alice.address, 0, 0))).to.deep.equal([]);
      expect(await ids(otc.getMakerOrders(bob.address, 0, MAX))).to.deep.equal([3]);
      expect(await ids(otc.getMakerOrders(carol.address, 0, 10))).to.deep.equal([]);
      const [, orders] = await otc.getMakerOrders(alice.address, 0, 10);
      expect(orders.map((o) => o.status)).to.deep.equal([Status.Open, Status.Filled, Status.Cancelled, Status.Open]);
    });

    it("taker index: reserved orders at creation, open orders on fill, never twice", async function () {
      const { otc, tka, mug, alice, bob, carol, dave } = await loadFixture(fixture);
      const reserved = await create(otc, alice, carol.address, erc20(tka, 1n), erc20(mug, 1n)); // 1
      const open = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n)); // 2
      const reservedCancelled = await create(otc, bob, carol.address, erc20(tka, 1n), erc20(mug, 1n)); // 3
      await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n)); // 4, untouched

      expect(await otc.takerOrderCount(carol.address)).to.equal(2n);
      expect(await ids(otc.getTakerOrders(carol.address, 0, 10))).to.deep.equal([1, 3]);

      await otc.connect(carol).fillOrder(reserved.id); // already indexed: not added again
      await otc.connect(carol).fillOrder(open.id); // indexed on fill
      await otc.connect(bob).cancelOrder(reservedCancelled.id); // stays listed
      expect(await otc.takerOrderCount(carol.address)).to.equal(3n);
      expect(await ids(otc.getTakerOrders(carol.address, 0, 10))).to.deep.equal([1, 3, 2]);
      expect(await ids(otc.getTakerOrders(carol.address, 3, 10))).to.deep.equal([]);
      expect(await ids(otc.getTakerOrders(carol.address, 0, 0))).to.deep.equal([]);
      const [, orders] = await otc.getTakerOrders(carol.address, 0, 10);
      expect(orders.map((o) => o.status)).to.deep.equal([Status.Filled, Status.Cancelled, Status.Filled]);
      expect(await otc.takerOrderCount(dave.address)).to.equal(0n);
      expect(await otc.takerOrderCount(alice.address)).to.equal(0n);
    });

    it("getOrder / getOrders return zeroed orders (status None) for unknown ids", async function () {
      const { otc, alice } = await fiveOrders();
      const zero = await otc.getOrder(0);
      expect(zero.status).to.equal(Status.None);
      expect(zero.maker).to.equal(ZERO);
      expect((await otc.getOrder(6)).status).to.equal(Status.None);
      const many = await otc.getOrders([3, 999, 0, 1]);
      expect(many.map((o) => o.status)).to.deep.equal([Status.Open, Status.None, Status.None, Status.Open]);
      expect(many[3].maker).to.equal(alice.address);
      expect(many[0].give.amountOrId).to.equal(3n);
      expect(await otc.getOrders([])).to.deep.equal([]);
    });

    it("canFill gives the right reason", async function () {
      const { otc, tka, mug, alice, bob, carol } = await loadFixture(fixture);
      const exp = BigInt(await time.latest()) + 100n;
      const open = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      const reserved = await create(otc, alice, bob.address, erc20(tka, 1n), erc20(mug, 1n));
      const expiring = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n), exp);
      const toFill = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      const toCancel = await create(otc, alice, ZERO, erc20(tka, 1n), erc20(mug, 1n));
      await otc.connect(bob).fillOrder(toFill.id);
      await otc.connect(alice).cancelOrder(toCancel.id);

      const cf = async (id, who) => {
        const [ok, reason] = await otc.canFill(id, who);
        return [ok, reason];
      };
      expect(await cf(open.id, bob.address)).to.deep.equal([true, ""]);
      expect(await cf(open.id, alice.address)).to.deep.equal([false, "maker cannot fill"]);
      expect(await cf(reserved.id, bob.address)).to.deep.equal([true, ""]);
      expect(await cf(reserved.id, carol.address)).to.deep.equal([false, "reserved for another wallet"]);
      expect(await cf(reserved.id, alice.address)).to.deep.equal([false, "maker cannot fill"]);
      expect(await cf(toFill.id, carol.address)).to.deep.equal([false, "not open"]);
      expect(await cf(toCancel.id, carol.address)).to.deep.equal([false, "not open"]);
      expect(await cf(0n, carol.address)).to.deep.equal([false, "not open"]);
      expect(await cf(999n, carol.address)).to.deep.equal([false, "not open"]);
      expect(await cf(expiring.id, carol.address)).to.deep.equal([true, ""]);
      await time.increaseTo(exp);
      expect(await cf(expiring.id, carol.address)).to.deep.equal([false, "expired"]);
      expect(await cf(expiring.id, alice.address)).to.deep.equal([false, "expired"]);
    });
  });

  // ------------------------------------------------------------------ reentrancy

  describe("reentrancy", function () {
    it("a token calling back into fillOrder during a fill is blocked; the outer fill completes", async function () {
      const { otc, evil, tka, mug, alice, bob, carol } = await loadFixture(fixture);
      const a = await create(otc, alice, ZERO, erc20(evil, 100n), erc20(tka, 10n));
      const b = await create(otc, carol, ZERO, erc20(tka, 5n), erc20(mug, 1n));
      await evil.arm(otc.target, 1 /* Fill */, b.id, false);

      await expect(otc.connect(bob).fillOrder(a.id)).to.not.be.reverted;
      expect(await evil.attempts()).to.equal(1n);
      expect(await evil.reentrySucceeded()).to.equal(false);
      const err = await evil.reentryError();
      expect(err.slice(0, 10)).to.equal(otc.interface.getError("ReentrancyGuardReentrantCall").selector);
      expect((await otc.getOrder(a.id)).status).to.equal(Status.Filled);
      expect((await otc.getOrder(b.id)).status).to.equal(Status.Open);
      expect(await evil.balanceOf(bob.address)).to.equal(ethers.parseEther("1000") + 100n);
    });

    it("a token calling back into cancelOrder during a cancel is blocked", async function () {
      const { otc, evil, tka, alice } = await loadFixture(fixture);
      const a = await create(otc, alice, ZERO, erc20(evil, 100n), erc20(tka, 10n));
      const b = await create(otc, alice, ZERO, erc20(tka, 5n), erc20(evil, 1n));
      await evil.arm(otc.target, 2 /* Cancel */, b.id, false);
      await otc.connect(alice).cancelOrder(a.id);
      expect(await evil.attempts()).to.equal(1n);
      expect(await evil.reentrySucceeded()).to.equal(false);
      expect((await evil.reentryError()).slice(0, 10)).to.equal(
        otc.interface.getError("ReentrancyGuardReentrantCall").selector,
      );
      expect((await otc.getOrder(b.id)).status).to.equal(Status.Open);
    });

    it("a token calling back during the createOrder escrow pull is blocked", async function () {
      const { otc, evil, tka, mug, alice, carol } = await loadFixture(fixture);
      const b = await create(otc, carol, ZERO, erc20(tka, 5n), erc20(mug, 1n));
      await evil.arm(otc.target, 1 /* Fill */, b.id, false);
      await create(otc, alice, ZERO, erc20(evil, 100n), erc20(tka, 1n));
      expect(await evil.attempts()).to.equal(1n);
      expect(await evil.reentrySucceeded()).to.equal(false);
      expect((await otc.getOrder(b.id)).status).to.equal(Status.Open);
    });

    it("if the attacker bubbles the revert, the whole fill reverts and nothing moves", async function () {
      const { otc, evil, tka, mug, alice, bob, carol } = await loadFixture(fixture);
      const a = await create(otc, alice, ZERO, erc20(evil, 100n), erc20(tka, 10n));
      const b = await create(otc, carol, ZERO, erc20(tka, 5n), erc20(mug, 1n));
      await evil.arm(otc.target, 1 /* Fill */, b.id, true);
      await expect(otc.connect(bob).fillOrder(a.id)).to.be.revertedWithCustomError(otc, "ReentrancyGuardReentrantCall");
      expect((await otc.getOrder(a.id)).status).to.equal(Status.Open);
      expect(await evil.balanceOf(otc.target)).to.equal(100n);
    });
  });

  // ------------------------------------------------------------------ gas

  describe("gas", function () {
    it("reports gas for create / fill / cancel", async function () {
      const { otc, tka, usdc, pup, art, alice, bob } = await loadFixture(fixture);
      const g = async (p) => (await (await p).wait()).gasUsed;
      // warm the open set / maker index with a first order so the numbers are typical
      await create(otc, alice, ZERO, erc20(tka, 1n), erc20(usdc, 1n));
      const c20 = await g(otc.connect(alice).createOrder(ZERO, erc20(tka, 100n), erc20(usdc, 50n), 0));
      const c721 = await g(otc.connect(alice).createOrder(ZERO, erc721(pup, 1n), erc721(art, 10n), 0));
      const cRes = await g(otc.connect(alice).createOrder(bob.address, erc20(tka, 100n), erc20(usdc, 50n), 0));
      const f20 = await g(otc.connect(bob).fillOrder(2));
      const f721 = await g(otc.connect(bob).fillOrder(3));
      const x = await g(otc.connect(alice).cancelOrder(4));
      console.log(
        `      gas: createOrder ERC20->ERC20 ${c20}, NFT->NFT ${c721}, reserved ${cRes} | ` +
          `fillOrder ERC20 ${f20}, NFT ${f721} | cancelOrder ${x}`,
      );
      expect(c20).to.be.lessThan(400000n);
      expect(f20).to.be.lessThan(250000n);
      expect(x).to.be.lessThan(150000n);
    });
  });
});
