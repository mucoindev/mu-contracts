const { expect } = require('chai');
const { ethers, upgrades, network } = require('hardhat');
const E = ethers.parseEther;
const SAFE = 'safeTransferFrom(address,address,uint256)';

describe('MuDogy UUPS candidate', function () {
  let owner, treasury, alice, bob, pups, mug, muo, muv, Dogy, dogy, args;
  beforeEach(async () => {
    [owner, treasury, alice, bob] = await ethers.getSigners();
    pups = await (await ethers.getContractFactory('MockMintpeg')).deploy('Pups', 'PUP');
    const Token = await ethers.getContractFactory('MockERC20');
    mug = await Token.deploy('Gold', 'MUG');
    muo = await Token.deploy('Ore', 'MUO');
    muv = await Token.deploy('Vault', 'MUV');
    Dogy = await ethers.getContractFactory('MuDogyUpgradeable');
    args = [owner.address, pups.target, mug.target, muo.target, muv.target, treasury.address, E('10'), E('2'), E('1'), 'https://example.test/dogy/'];
    dogy = await upgrades.deployProxy(Dogy, args, { kind: 'uups' });
    await dogy.waitForDeployment();
    await pups.mint(alice.address, 3);
    await mug.mint(alice.address, E('100'));
    await muo.mint(alice.address, E('30'));
    await muv.mint(alice.address, E('12'));
  });
  async function birth(id = 0) {
    await mug.connect(alice).approve(dogy.target, E('10'));
    return pups.connect(alice)[SAFE](alice.address, dogy.target, id);
  }

  it('initializes atomically, starts paused, and locks both initialization paths', async () => {
    expect(await dogy.name()).eq('MU Dogy');
    expect(await dogy.owner()).eq(owner.address);
    expect(await dogy.paused()).eq(true);
    expect(await dogy.nextDogyId()).eq(1);
    expect(await dogy.totalSupply()).eq(0);
    await expect(dogy.initialize(...args)).revertedWithCustomError(dogy, 'InvalidInitialization');
    const implementation = Dogy.attach(await upgrades.erc1967.getImplementationAddress(dogy.target));
    await expect(implementation.initialize(...args)).revertedWithCustomError(dogy, 'InvalidInitialization');
    await expect(birth()).revertedWithCustomError(dogy, 'EnforcedPause');
    expect(await pups.ownerOf(0)).eq(alice.address);
  });

  it('preserves NFT ownership, approvals, records, royalties and configuration through a real upgrade', async () => {
    await dogy.unpause();
    await birth();
    await mug.connect(alice).approve(dogy.target, E('2'));
    await dogy.connect(alice).reroll(1, 0);
    await dogy.connect(alice).lock(1, 'Orbit');
    await dogy.connect(alice).approve(bob.address, 1);
    await dogy.setRoyalty(treasury.address, 500);
    await dogy.setPrice(E('11'));
    const record = await dogy.births(1);
    const previous = await upgrades.erc1967.getImplementationAddress(dogy.target);
    await dogy.pause();
    const V2 = await ethers.getContractFactory('MuDogyUpgradeFixture');
    await upgrades.validateUpgrade(Dogy, V2, { kind: 'uups' });
    const next = await upgrades.upgradeProxy(dogy.target, V2, { call: { fn: 'initializeV2', args: [2] } });
    expect(next.target).eq(dogy.target);
    expect(await upgrades.erc1967.getImplementationAddress(next.target)).not.eq(previous);
    expect(await next.births(1)).deep.eq(record);
    expect(await next.ownerOf(1)).eq(alice.address);
    expect(await next.getApproved(1)).eq(bob.address);
    expect(await next.royaltyInfo(1, 10000)).deep.eq([treasury.address, 500n]);
    expect(await next.price()).eq(E('11'));
    expect(await next.nextDogyId()).eq(2);
    expect(await next.totalSupply()).eq(1);
    expect(await next.dogyOfPup(0)).eq(1);
    expect(await next.pups()).eq(pups.target);
    expect(await next.mug()).eq(mug.target);
    expect(await next.muo()).eq(muo.target);
    expect(await next.muv()).eq(muv.target);
    expect(await next.treasury()).eq(treasury.address);
    expect(await next.tokenURI(1)).eq('https://example.test/dogy/1');
    expect(await next.rerollBase()).eq(E('2'));
    expect(await next.rerollStep()).eq(E('1'));
    expect(await next.blocked(349)).eq(true);
    expect(await next.owner()).eq(owner.address);
    expect(await next.paused()).eq(true);
    expect(await next.releaseNumber()).eq(2);
    expect(await mug.balanceOf(treasury.address)).eq(E('12'));
    await expect(next.initializeV2(3)).revertedWithCustomError(next, 'InvalidInitialization');
    await next.unpause();
    await expect(next.connect(alice).reroll(1, 0)).revertedWithCustomError(next, 'DogyLocked');
    await mug.connect(alice).approve(next.target, E('11'));
    await pups.connect(alice)[SAFE](alice.address, next.target, 1);
    expect(await next.ownerOf(2)).eq(alice.address);
  });

  it('rejects unauthorized upgrades, unpaused upgrades, and non-UUPS implementations', async () => {
    const next = await Dogy.deploy();
    await expect(dogy.connect(alice).upgradeToAndCall(next.target, '0x')).revertedWithCustomError(dogy, 'OwnableUnauthorizedAccount');
    await dogy.unpause();
    await expect(dogy.upgradeToAndCall(next.target, '0x')).revertedWithCustomError(dogy, 'ExpectedPause');
    await dogy.pause();
    await expect(dogy.upgradeToAndCall(mug.target, '0x')).revertedWithCustomError(dogy, 'ERC1967InvalidImplementation');
    await expect(next.upgradeToAndCall(next.target, '0x')).revertedWithCustomError(next, 'UUPSUnauthorizedCallContext');
  });

  it('rolls back a failed upgrade migration including the implementation slot', async () => {
    const previous = await upgrades.erc1967.getImplementationAddress(dogy.target);
    const next = await Dogy.deploy();
    await expect(dogy.upgradeToAndCall(next.target, Dogy.interface.encodeFunctionData('initialize', args)))
      .revertedWithCustomError(dogy, 'InvalidInitialization');
    expect(await upgrades.erc1967.getImplementationAddress(dogy.target)).eq(previous);
  });

  it('fails validation when an implementation shifts existing storage', async () => {
    const Bad = await ethers.getContractFactory('BadDogyLayoutFixture');
    let error;
    try { await upgrades.validateUpgrade(Dogy, Bad, { kind: 'uups' }); }
    catch (caught) { error = caught; }
    expect(error, 'incompatible storage must be rejected').instanceOf(Error);
    expect(error.message).include('storage layout is incompatible');
  });

  it('requires the timelock delay after ownership transfers and removes the old owner authority', async () => {
    const Lock = await ethers.getContractFactory('UpgradeTimelockFixture');
    const timelock = await Lock.deploy(172800, [owner.address], [owner.address]);
    await dogy.transferOwnership(timelock.target);
    const zero = ethers.ZeroHash;
    async function schedule(data, salt) {
      await timelock.schedule(dogy.target, 0, data, zero, salt, 172800);
      return () => timelock.execute(dogy.target, 0, data, zero, salt);
    }
    const accept = await schedule(Dogy.interface.encodeFunctionData('acceptOwnership'), zero);
    await expect(accept()).reverted;
    await network.provider.send('evm_increaseTime', [172800]);
    await network.provider.send('evm_mine');
    await accept();
    const next = await Dogy.deploy();
    await expect(dogy.upgradeToAndCall(next.target, '0x')).revertedWithCustomError(dogy, 'OwnableUnauthorizedAccount');
    const execute = await schedule(Dogy.interface.encodeFunctionData('upgradeToAndCall', [next.target, '0x']), ethers.id('upgrade'));
    await expect(execute()).reverted;
    await network.provider.send('evm_increaseTime', [172800]);
    await network.provider.send('evm_mine');
    await execute();
    expect(await upgrades.erc1967.getImplementationAddress(dogy.target)).eq(next.target);
  });

  it('keeps holder consent and atomic payment/burn protections through the proxy', async () => {
    await dogy.unpause();
    await expect(pups.connect(alice)[SAFE](alice.address, dogy.target, 0)).reverted;
    expect(await pups.ownerOf(0)).eq(alice.address);
    expect(await dogy.totalSupply()).eq(0);
    await pups.connect(alice).setApprovalForAll(bob.address, true);
    await mug.connect(alice).approve(dogy.target, E('10'));
    await expect(pups.connect(bob)[SAFE](alice.address, dogy.target, 0)).revertedWithCustomError(dogy, 'OperatorNotHolder');
    await birth();
    await expect(pups.ownerOf(0)).reverted;
    expect(await dogy.ownerOf(1)).eq(alice.address);
    expect((await dogy.births(1)).muo).eq(E('30'));
    await expect(dogy.connect(bob).lock(1, 'Stolen')).revertedWithCustomError(dogy, 'NotDogyOwner');
    await expect(dogy.connect(bob).pause()).revertedWithCustomError(dogy, 'OwnableUnauthorizedAccount');
  });

  it('blocks token callback reentrancy in proxy storage and clears the guard after each call', async () => {
    const token = await (await ethers.getContractFactory('ReentrantMUG')).deploy();
    const guarded = await upgrades.deployProxy(Dogy, args.map((arg, i) => i === 2 ? token.target : arg), { kind: 'uups' });
    await guarded.unpause();
    await token.mint(alice.address, E('100'));
    await token.connect(alice).approve(guarded.target, E('100'));
    await pups.mintId(token.target, 101);
    await token.arm(pups.target, guarded.target, 101, 1);
    await pups.connect(alice)[SAFE](alice.address, guarded.target, 0);
    expect(await token.attempted()).eq(true);
    expect(await token.reentrySucceeded()).eq(false);
    expect(await token.reentryError()).eq(guarded.interface.getError('ReentrancyGuardReentrantCall').selector);
    expect(await pups.ownerOf(101)).eq(token.target);
    await token.arm(pups.target, guarded.target, 1, 2);
    await guarded.connect(alice).reroll(1, 0);
    expect(await token.reentrySucceeded()).eq(false);
    expect(await token.reentryError()).eq(guarded.interface.getError('ReentrancyGuardReentrantCall').selector);
    await guarded.connect(alice).reroll(1, 0);
    expect((await guarded.births(1)).rerollCounts[0]).eq(2);
  });
});
