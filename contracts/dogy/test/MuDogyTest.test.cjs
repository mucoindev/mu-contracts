const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const BASE = "https://new.mu.money/nft/mu-dogy-test/";
const ZERO = ethers.ZeroAddress;

async function fixture() {
  const [deployer, signer, alice, bob, other] = await ethers.getSigners();
  const F = await ethers.getContractFactory("MuDogyTest");
  const nft = await F.deploy(signer.address, BASE);
  const { chainId } = await ethers.provider.getNetwork();
  return { F, nft, deployer, signer, alice, bob, other, chainId };
}

function digest(chainId, contract, to, dogyId, dna) {
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "address", "uint256", "bytes32"],
    [chainId, contract, to, dogyId, dna],
  );
}

/** What the server does: personal_sign over the 32-byte voucher hash. */
async function voucher(wallet, { chainId, contract, to, dogyId, dna }) {
  return wallet.signMessage(ethers.getBytes(digest(chainId, contract, to, dogyId, dna)));
}

const dnaOf = (s) => ethers.id(s);

describe("MuDogyTest", function () {
  it("deploys with name, symbol, owner = deployer, signer and base URI", async function () {
    const { nft, deployer, signer } = await loadFixture(fixture);
    expect(await nft.name()).to.equal("MU Dogy Test");
    expect(await nft.symbol()).to.equal("MUDOGYTEST");
    expect(await nft.owner()).to.equal(deployer.address);
    expect(await nft.signer()).to.equal(signer.address);
    expect(await nft.totalMinted()).to.equal(0n);
  });

  it("deployed runtime code is byte-identical to the artifact (Worker hash check)", async function () {
    const { F, nft, other } = await loadFixture(fixture);
    const art = await artifacts.readArtifact("MuDogyTest");
    const code = await ethers.provider.getCode(nft.target);
    expect(code).to.equal(art.deployedBytecode);
    // Different constructor args, same runtime code.
    const nft2 = await F.deploy(other.address, "ipfs://x/");
    expect(ethers.keccak256(await ethers.provider.getCode(nft2.target))).to.equal(ethers.keccak256(art.deployedBytecode));
  });

  it("mints with a valid voucher: tokenId = dogyId, dna stored, Minted emitted", async function () {
    const { nft, signer, alice, chainId } = await loadFixture(fixture);
    const dna = dnaOf("dogy-7");
    const sig = await voucher(signer, { chainId, contract: nft.target, to: alice.address, dogyId: 7, dna });
    expect(await nft.voucherHash(alice.address, 7, dna)).to.equal(digest(chainId, nft.target, alice.address, 7, dna));

    const tx = nft.connect(alice).mint(7, dna, sig);
    await expect(tx).to.emit(nft, "Transfer").withArgs(ZERO, alice.address, 7);
    await expect(tx).to.emit(nft, "Minted").withArgs(7, alice.address, dna);
    expect(await nft.ownerOf(7)).to.equal(alice.address);
    expect(await nft.dna(7)).to.equal(dna);
    expect(await nft.totalMinted()).to.equal(1n);

    const dna2 = dnaOf("dogy-1");
    await nft.connect(alice).mint(1, dna2, await voucher(signer, { chainId, contract: nft.target, to: alice.address, dogyId: 1, dna: dna2 }));
    expect(await nft.totalMinted()).to.equal(2n);
    expect(await nft.balanceOf(alice.address)).to.equal(2n);
  });

  it("rejects a voucher from the wrong signer", async function () {
    const { nft, alice, bob, chainId } = await loadFixture(fixture);
    const dna = dnaOf("x");
    const sig = await voucher(bob, { chainId, contract: nft.target, to: alice.address, dogyId: 1, dna });
    await expect(nft.connect(alice).mint(1, dna, sig)).to.be.revertedWithCustomError(nft, "InvalidSigner").withArgs(bob.address);
  });

  it("rejects a voucher used by a different wallet", async function () {
    const { nft, signer, alice, bob, chainId } = await loadFixture(fixture);
    const dna = dnaOf("x");
    const sig = await voucher(signer, { chainId, contract: nft.target, to: alice.address, dogyId: 1, dna });
    const recovered = ethers.verifyMessage(ethers.getBytes(digest(chainId, nft.target, bob.address, 1, dna)), sig);
    await expect(nft.connect(bob).mint(1, dna, sig)).to.be.revertedWithCustomError(nft, "InvalidSigner").withArgs(recovered);
  });

  it("rejects a voucher for another chain or another contract", async function () {
    const { F, nft, signer, alice, chainId } = await loadFixture(fixture);
    const dna = dnaOf("x");
    const realDigest = ethers.getBytes(digest(chainId, nft.target, alice.address, 1, dna));

    const otherChain = await voucher(signer, { chainId: 43114n, contract: nft.target, to: alice.address, dogyId: 1, dna });
    await expect(nft.connect(alice).mint(1, dna, otherChain))
      .to.be.revertedWithCustomError(nft, "InvalidSigner")
      .withArgs(ethers.verifyMessage(realDigest, otherChain));

    const nft2 = await F.deploy(signer.address, BASE);
    const forNft2 = await voucher(signer, { chainId, contract: nft2.target, to: alice.address, dogyId: 1, dna });
    await expect(nft.connect(alice).mint(1, dna, forNft2))
      .to.be.revertedWithCustomError(nft, "InvalidSigner")
      .withArgs(ethers.verifyMessage(realDigest, forNft2));
    await nft2.connect(alice).mint(1, dna, forNft2); // valid where it was meant to be used
  });

  it("rejects a tampered dogyId or dna, and malformed signatures", async function () {
    const { nft, signer, alice, chainId } = await loadFixture(fixture);
    const dna = dnaOf("x");
    const sig = await voucher(signer, { chainId, contract: nft.target, to: alice.address, dogyId: 1, dna });
    await expect(nft.connect(alice).mint(2, dna, sig)).to.be.revertedWithCustomError(nft, "InvalidSigner");
    await expect(nft.connect(alice).mint(1, dnaOf("y"), sig)).to.be.revertedWithCustomError(nft, "InvalidSigner");
    await expect(nft.connect(alice).mint(1, dna, "0x1234")).to.be.revertedWithCustomError(nft, "ECDSAInvalidSignatureLength").withArgs(2);
    expect(await nft.totalMinted()).to.equal(0n);
  });

  it("a dogyId mints only once (replay and fresh vouchers alike)", async function () {
    const { nft, signer, alice, bob, chainId } = await loadFixture(fixture);
    const dna = dnaOf("x");
    const sig = await voucher(signer, { chainId, contract: nft.target, to: alice.address, dogyId: 5, dna });
    await nft.connect(alice).mint(5, dna, sig);
    await expect(nft.connect(alice).mint(5, dna, sig)).to.be.revertedWithCustomError(nft, "AlreadyMinted").withArgs(5);
    const fresh = await voucher(signer, { chainId, contract: nft.target, to: bob.address, dogyId: 5, dna: dnaOf("z") });
    await expect(nft.connect(bob).mint(5, dnaOf("z"), fresh)).to.be.revertedWithCustomError(nft, "AlreadyMinted").withArgs(5);
    expect(await nft.dna(5)).to.equal(dna);
    expect(await nft.totalMinted()).to.equal(1n);
  });

  it("tokenURI = baseURI + id; reverts for unminted ids", async function () {
    const { nft, signer, alice, chainId } = await loadFixture(fixture);
    const dna = dnaOf("x");
    await nft.connect(alice).mint(42, dna, await voucher(signer, { chainId, contract: nft.target, to: alice.address, dogyId: 42, dna }));
    expect(await nft.tokenURI(42)).to.equal(BASE + "42");
    await expect(nft.tokenURI(43)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken").withArgs(43);
  });

  it("owner can rotate the signer and change the base URI; nobody else can", async function () {
    const { nft, signer, alice, bob, other, chainId } = await loadFixture(fixture);
    await expect(nft.connect(alice).setSigner(alice.address))
      .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
    await expect(nft.connect(alice).setBaseURI("x")).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount").withArgs(alice.address);
    await expect(nft.setSigner(ZERO)).to.be.revertedWithCustomError(nft, "ZeroSigner");

    const dna = dnaOf("x");
    const oldSig = await voucher(signer, { chainId, contract: nft.target, to: alice.address, dogyId: 1, dna });
    await expect(nft.setSigner(other.address)).to.emit(nft, "SignerSet").withArgs(other.address);
    expect(await nft.signer()).to.equal(other.address);
    await expect(nft.connect(alice).mint(1, dna, oldSig)).to.be.revertedWithCustomError(nft, "InvalidSigner").withArgs(signer.address);
    await nft.connect(alice).mint(1, dna, await voucher(other, { chainId, contract: nft.target, to: alice.address, dogyId: 1, dna }));

    await expect(nft.setBaseURI("https://example.test/d/")).to.emit(nft, "BaseURISet").withArgs("https://example.test/d/");
    expect(await nft.tokenURI(1)).to.equal("https://example.test/d/1");
    expect(bob.address).to.not.equal(ZERO);
  });

  it("rejects a zero signer at deploy", async function () {
    const { F } = await loadFixture(fixture);
    await expect(F.deploy(ZERO, BASE)).to.be.revertedWithCustomError(F, "ZeroSigner");
  });
});
