// Smoke test of the LEGACY SimpleOTC (contracts/legacy/SimpleOTC.sol, a copy of the
// verified source at 0xC4bdf802…). It only proves the copy compiles and behaves like
// the live contract the app still has to read, and that the exported ABI matches.
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const EXPORT_FILE = path.resolve(__dirname, "..", "..", "..", "release", "otc", "SimpleOTC.json");
const TOKEN = 0;
const NFT = 1;

async function fixture() {
  const [deployer, alice, bob, feeSink] = await ethers.getSigners();
  const mug = await (await ethers.getContractFactory("MockERC20")).deploy("Mu Gold", "MUG");
  const tka = await (await ethers.getContractFactory("MockERC20")).deploy("Token A", "TKA");
  const pup = await (await ethers.getContractFactory("MockERC721")).deploy("MU Pup", "PUP");
  const otc = await (await ethers.getContractFactory("SimpleOTC")).deploy(mug.target, ethers.parseEther("1"), feeSink.address);
  for (const u of [alice, bob]) {
    await mug.mint(u.address, ethers.parseEther("10"));
    await tka.mint(u.address, ethers.parseEther("1000"));
    await mug.connect(u).approve(otc.target, ethers.MaxUint256);
    await tka.connect(u).approve(otc.target, ethers.MaxUint256);
    await pup.connect(u).setApprovalForAll(otc.target, true);
  }
  await pup.mint(bob.address, 7);
  return { deployer, alice, bob, feeSink, mug, tka, pup, otc };
}

describe("SimpleOTC (legacy, reference only)", function () {
  it("create -> deposit (maker) -> deposit (taker) -> finalize", async function () {
    const { alice, bob, feeSink, mug, tka, pup, otc } = await loadFixture(fixture);
    await expect(otc.connect(alice).createOffer(bob.address, TOKEN, tka.target, 100n, NFT, pup.target, 7n))
      .to.emit(otc, "OfferCreated").withArgs(0n, alice.address, bob.address);
    expect(await mug.balanceOf(feeSink.address)).to.equal(ethers.parseEther("1"));
    expect(await otc.nextOfferId()).to.equal(1n);
    expect(await otc.activeOffers()).to.equal(1n);

    await otc.connect(alice).deposit(0);
    await otc.connect(bob).deposit(0);
    expect([...(await otc.isFinalizable(0))]).to.deep.equal([true, true, true, true]);
    await expect(otc.connect(bob).finalize(0)).to.emit(otc, "Finalized").withArgs(0n);

    expect(await pup.ownerOf(7)).to.equal(alice.address);
    expect(await tka.balanceOf(bob.address)).to.equal(ethers.parseEther("1000") + 100n);
    expect(await otc.activeOffers()).to.equal(0n);
    const offers = await otc.getOffersByAddressPaginated(alice.address, 0, 10);
    expect(offers).to.have.length(1);
    expect(offers[0].isActive).to.equal(false);
  });

  it("has the pagination underflow MuOTC fixes (offset past the end reverts)", async function () {
    const { alice, bob, tka, otc } = await loadFixture(fixture);
    await otc.connect(alice).createOffer(bob.address, TOKEN, tka.target, 1n, TOKEN, tka.target, 2n);
    await expect(otc.getOffersByAddressPaginated(alice.address, 5, 10)).to.be.reverted;
  });

  it("exported release/otc/SimpleOTC.json has the live address and this ABI", async function () {
    const art = await artifacts.readArtifact("SimpleOTC");
    expect(fs.existsSync(EXPORT_FILE), "run scripts/export-muotc.cjs first").to.equal(true);
    const exported = JSON.parse(fs.readFileSync(EXPORT_FILE, "utf8"));
    expect(exported.address).to.equal("0xC4bdf802a9b77e8e09a136d55d6A14B66e94aF10");
    expect(exported.abi).to.deep.equal(art.abi);
    const names = exported.abi.filter((f) => f.type === "function").map((f) => f.name).sort();
    expect(names).to.include.members(["createOffer", "deposit", "finalize", "cancel", "offers", "getAllActiveOffersPaginated"]);
  });
});
