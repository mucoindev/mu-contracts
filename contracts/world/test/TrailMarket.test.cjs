const { expect } = require('chai');
const { ethers, network, artifacts } = require('hardhat');
const e = ethers.parseEther;
const MAX = ethers.MaxUint256;
const fields = { Withdraw: [
  { name: 'account', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };
describe('TrailMarket', function () {
  let owner, alice, bob, rewards, signer, mug, market, addr, deadline;
  beforeEach(async () => {
    [owner, alice, bob, rewards, signer] = await ethers.getSigners();
    mug = await (await ethers.getContractFactory('MockMug')).deploy();
    market = await (await ethers.getContractFactory('TrailMarket')).deploy(await mug.getAddress(), rewards.address, signer.address);
    addr = await market.getAddress();
    deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
    for (const person of [owner, alice, bob]) {
      await mug.connect(person).approve(addr, MAX);
      await market.connect(person).approve(addr, MAX);
    }
    await mug.transfer(alice.address, e('1000'));
    await mug.transfer(bob.address, e('1000'));
    await market.transfer(alice.address, e('100000'));
    await market.transfer(bob.address, e('100000'));
  });
  async function pool() {
    await market.addLiquidity(e('1000'), e('100000'), 0, 0, deadline);
    await market.setPaused(false);
  }
  async function signature(account, amount, nonce, expiry = deadline, overrides = {}, signing = signer) {
    return signing.signTypedData({ name: 'TrailMarket', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: addr, ...overrides }, fields, { account, amount, nonce, deadline: expiry });
  }
  async function solvent() {
    expect(await mug.balanceOf(addr)).gte(await market.reserveMug());
    expect(await market.balanceOf(addr)).gte((await market.reserveTrail()) + (await market.gameBacking()));
  }
  it('mints a fixed supply, starts paused, and has a constructor-independent runtime hash', async () => {
    expect(await market.totalSupply()).eq(e('10000000'));
    expect(await market.paused()).eq(true);
    expect(await market.mug()).eq(await mug.getAddress());
    expect(await market.rewards()).eq(rewards.address);
    const artifact = await artifacts.readArtifact('TrailMarket');
    expect(ethers.keccak256(await ethers.provider.getCode(addr))).eq(ethers.keccak256(artifact.deployedBytecode));
    const other = await (await ethers.getContractFactory('TrailMarket')).connect(alice).deploy(await mug.getAddress(), bob.address, owner.address);
    expect(ethers.keccak256(await ethers.provider.getCode(await other.getAddress()))).eq(ethers.keccak256(artifact.deployedBytecode));
  });
  it('rejects zero addresses and non-token MUG', async () => {
    const factory = await ethers.getContractFactory('TrailMarket');
    await expect(factory.deploy(ethers.ZeroAddress, rewards.address, signer.address)).revertedWith('Zero address');
    await expect(factory.deploy(await mug.getAddress(), ethers.ZeroAddress, signer.address)).revertedWith('Zero address');
    await expect(factory.deploy(await mug.getAddress(), rewards.address, ethers.ZeroAddress)).revertedWith('Zero address');
    await expect(factory.deploy(alice.address, rewards.address, signer.address)).revertedWith('Invalid address');
  });
  it('initializes 100 TRAIL per MUG with permanently locked minimum shares', async () => {
    await expect(market.addLiquidity(e('1'), e('99'), 0, 0, deadline)).revertedWith('Initial ratio');
    await expect(market.addLiquidity(e('1'), e('100'), 0, 0, deadline)).emit(market, 'LiquidityAdded');
    expect(await market.reserveMug()).eq(e('1'));
    expect(await market.reserveTrail()).eq(e('100'));
    expect(await market.totalLiquidity()).eq(e('10'));
    expect(await market.liquidityOf(owner.address)).eq(e('10') - 1000n);
    expect(await market.liquidityOf('0x0000000000000000000000000000000000000001')).eq(1000);
    await solvent();
  });
  it('buy applies 1% MUG fee to Rewards, keeps principal and floats price', async () => {
    await pool();
    const [out, fee] = await market.quoteMugForTrail(e('10'));
    expect(fee).eq(e('0.1'));
    const k = (await market.reserveMug()) * (await market.reserveTrail());
    const before = await market.balanceOf(alice.address);
    await expect(market.connect(alice).swapMugForTrail(e('10'), out, deadline)).emit(market, 'Swap').withArgs(alice.address, true, e('10'), out, fee);
    expect(await mug.balanceOf(rewards.address)).eq(fee);
    expect(await market.balanceOf(alice.address)).eq(before + out);
    expect(await market.reserveMug()).eq(e('1009.9'));
    expect((await market.reserveMug()) * (await market.reserveTrail())).gte(k);
    expect((await market.quoteMugForTrail(e('10')))[0]).lt(out);
    await solvent();
  });
  it('sell charges the output fee in MUG and moves price the other way', async () => {
    await pool();
    const [out, fee] = await market.quoteTrailForMug(e('1000'));
    const before = await mug.balanceOf(alice.address);
    await market.connect(alice).swapTrailForMug(e('1000'), out, deadline);
    expect(await mug.balanceOf(alice.address)).eq(before + out);
    expect(await mug.balanceOf(rewards.address)).eq(fee);
    expect(await market.reserveMug()).eq(e('1000') - out - fee);
    expect((await market.quoteMugForTrail(e('10')))[0]).gt(e('980'));
    await solvent();
  });
  it('buy/sell roundtrip costs fees rather than creating MUG', async () => {
    await pool();
    const start = await mug.balanceOf(alice.address);
    const [bought] = await market.quoteMugForTrail(e('100'));
    await market.connect(alice).swapMugForTrail(e('100'), bought, deadline);
    const [sold] = await market.quoteTrailForMug(bought);
    await market.connect(alice).swapTrailForMug(bought, sold, deadline);
    expect(await mug.balanceOf(alice.address)).lt(start);
    expect(await mug.balanceOf(rewards.address)).gt(e('1'));
    await solvent();
  });
  it('rejects slippage, expired orders, zero outputs and missing approvals atomically', async () => {
    await pool();
    const [out] = await market.quoteMugForTrail(e('10'));
    await expect(market.connect(alice).swapMugForTrail(e('10'), out + 1n, deadline)).revertedWith('Slippage');
    await expect(market.connect(alice).swapTrailForMug(e('10'), e('10'), deadline)).revertedWith('Slippage');
    await expect(market.connect(alice).swapMugForTrail(e('1'), 0, 1)).revertedWith('Expired');
    await expect(market.connect(alice).swapTrailForMug(0, 0, deadline)).revertedWith('Slippage');
    await expect(market.connect(alice).swapMugForTrail(1, 0, deadline)).revertedWith('Slippage');
    await market.connect(alice).approve(addr, 0);
    await expect(market.connect(alice).swapTrailForMug(e('10'), 0, deadline)).revertedWithCustomError(market, 'ERC20InsufficientAllowance');
    expect(await market.reserveMug()).eq(e('1000'));
  });
  it('adds liquidity at current floating ratio, using only optimal token amounts', async () => {
    await pool();
    await market.connect(alice).swapMugForTrail(e('50'), 0, deadline);
    const quote = await market.connect(bob).addLiquidity.staticCall(e('100'), e('1000'), 0, 0, deadline);
    expect(quote.mugUsed).lt(e('100'));
    expect(quote.trailUsed).eq(e('1000'));
    const before = await mug.balanceOf(bob.address);
    await market.connect(bob).addLiquidity(e('100'), e('1000'), quote.mugUsed, quote.trailUsed, deadline);
    expect(await mug.balanceOf(bob.address)).eq(before - quote.mugUsed);
    expect(await market.liquidityOf(bob.address)).eq(quote.shares);
    await solvent();
  });
  it('only LP owners redeem their shares, with slippage/deadline and paused exits', async () => {
    await pool();
    await market.connect(alice).addLiquidity(e('10'), e('1000'), 0, 0, deadline);
    const shares = await market.liquidityOf(alice.address);
    await expect(market.connect(bob).removeLiquidity(shares, 0, 0, deadline)).revertedWith('Invalid shares');
    await expect(market.connect(alice).removeLiquidity(shares, e('11'), 0, deadline)).revertedWith('Slippage');
    await expect(market.connect(alice).removeLiquidity(shares, 0, 0, 1)).revertedWith('Expired');
    await market.setPaused(true);
    await market.connect(alice).removeLiquidity(shares, e('10'), e('1000'), deadline);
    expect(await market.liquidityOf(alice.address)).eq(0);
    await solvent();
  });
  it('LP deposit slippage/deadlines protect the chosen amounts', async () => {
    await pool();
    await expect(market.connect(alice).addLiquidity(e('1'), e('100'), e('2'), 0, deadline)).revertedWith('Slippage');
    await expect(market.connect(alice).addLiquidity(e('1'), e('100'), 0, e('101'), deadline)).revertedWith('Slippage');
    await expect(market.connect(alice).addLiquidity(e('1'), e('100'), 0, 0, 1)).revertedWith('Expired');
    await expect(market.connect(alice).addLiquidity(0, e('100'), 0, 0, deadline)).revertedWith('Zero amount');
  });
  it('donations cannot change reserves, quotes, LP shares or game backing', async () => {
    await pool();
    const quote = await market.quoteMugForTrail(e('1'));
    await mug.transfer(addr, e('77'));
    await market.transfer(addr, e('999'));
    expect(await market.quoteMugForTrail(e('1'))).deep.eq(quote);
    expect(await market.reserveMug()).eq(e('1000'));
    expect(await market.reserveTrail()).eq(e('100000'));
    expect(await market.gameBacking()).eq(0);
    const shares = await market.liquidityOf(owner.address);
    await market.removeLiquidity(shares, 0, 0, deadline);
    expect(await mug.balanceOf(addr)).gte(e('77'));
    expect(await market.balanceOf(addr)).gte(e('999'));
  });
  it('records whole-coin game deposits and reward funding in separate backing', async () => {
    await pool();
    await expect(market.fundGameRewards(e('100'))).emit(market, 'GameRewardsFunded').withArgs(owner.address, e('100'));
    await expect(market.connect(alice).depositGame(e('50'))).emit(market, 'GameDeposit').withArgs(alice.address, e('50'));
    expect(await market.gameBacking()).eq(e('150'));
    expect(await market.reserveTrail()).eq(e('100000'));
    for (const amount of [0n, 1n, e('1.5')]) {
      await expect(market.depositGame(amount)).revertedWith('Whole coins only');
      await expect(market.fundGameRewards(amount)).revertedWith('Whole coins only');
    }
    await solvent();
  });
  it('domain-bound authorized withdrawal releases game backing only, including when paused', async () => {
    await pool();
    await market.fundGameRewards(e('50'));
    const sig = await signature(alice.address, e('10'), 7);
    await market.setPaused(true);
    const before = await market.balanceOf(alice.address);
    await expect(market.connect(alice).withdrawGame(alice.address, e('10'), 7, deadline, sig)).emit(market, 'GameWithdrawal').withArgs(alice.address, e('10'), 7);
    expect(await market.balanceOf(alice.address)).eq(before + e('10'));
    expect(await market.gameBacking()).eq(e('40'));
    expect(await market.reserveTrail()).eq(e('100000'));
    expect(await market.usedNonces(alice.address, 7)).eq(true);
    await solvent();
  });
  it('rejects replay, altered amount, other caller, wrong domain, wrong chain and wrong signer', async () => {
    await pool();
    await market.fundGameRewards(e('100'));
    const sig = await signature(alice.address, e('10'), 7);
    await expect(market.connect(bob).withdrawGame(alice.address, e('10'), 7, deadline, sig)).revertedWith('Wrong account');
    await expect(market.connect(alice).withdrawGame(alice.address, e('11'), 7, deadline, sig)).revertedWith('Invalid signature');
    for (const overrides of [{ verifyingContract: bob.address }, { chainId: 43114n }, { version: '2' }]) {
      const bad = await signature(alice.address, e('10'), 7, deadline, overrides);
      await expect(market.connect(alice).withdrawGame(alice.address, e('10'), 7, deadline, bad)).revertedWith('Invalid signature');
    }
    const bad = await signature(alice.address, e('10'), 7, deadline, {}, bob);
    await expect(market.connect(alice).withdrawGame(alice.address, e('10'), 7, deadline, bad)).revertedWith('Invalid signature');
    await market.connect(alice).withdrawGame(alice.address, e('10'), 7, deadline, sig);
    await expect(market.connect(alice).withdrawGame(alice.address, e('10'), 7, deadline, sig)).revertedWith('Nonce used');
  });
  it('cannot authorize withdrawal from LP reserves or donations, even with valid signer', async () => {
    await pool();
    await market.transfer(addr, e('2000'));
    const sig = await signature(alice.address, e('1'), 1);
    await expect(market.connect(alice).withdrawGame(alice.address, e('1'), 1, deadline, sig)).revertedWith('Game backing');
    await market.fundGameRewards(e('1'));
    await market.connect(alice).withdrawGame(alice.address, e('1'), 1, deadline, sig);
    expect(await market.gameBacking()).eq(0);
    expect(await market.reserveTrail()).eq(e('100000'));
    await solvent();
  });
  it('expired authorization does not consume nonce; nonces are scoped to each account', async () => {
    await pool();
    await market.fundGameRewards(e('10'));
    const expired = await signature(alice.address, e('1'), 0, 1);
    await expect(market.connect(alice).withdrawGame(alice.address, e('1'), 0, 1, expired)).revertedWith('Expired');
    expect(await market.usedNonces(alice.address, 0)).eq(false);
    for (const person of [alice, bob]) {
      const sig = await signature(person.address, e('1'), 0);
      await market.connect(person).withdrawGame(person.address, e('1'), 0, deadline, sig);
    }
    expect(await market.gameBacking()).eq(e('8'));
  });
  it('owner controls pause and signer, rotation revokes previous signatures', async () => {
    await pool();
    await market.fundGameRewards(e('10'));
    const sig = await signature(alice.address, e('1'), 2);
    await expect(market.connect(alice).setPaused(true)).revertedWithCustomError(market, 'OwnableUnauthorizedAccount');
    await expect(market.connect(alice).setGameSigner(alice.address)).revertedWithCustomError(market, 'OwnableUnauthorizedAccount');
    await expect(market.setGameSigner(ethers.ZeroAddress)).revertedWith('Zero address');
    await market.setGameSigner(bob.address);
    await expect(market.connect(alice).withdrawGame(alice.address, e('1'), 2, deadline, sig)).revertedWith('Invalid signature');
    await market.setPaused(true);
    await expect(market.connect(alice).swapMugForTrail(e('1'), 0, deadline)).revertedWith('Paused');
    await expect(market.connect(alice).swapTrailForMug(e('1'), 0, deadline)).revertedWith('Paused');
    await expect(market.connect(alice).depositGame(e('1'))).revertedWith('Paused');
    await market.fundGameRewards(e('1'));
  });
  it('rejects taxed MUG deposits and prevents external token callback reentrancy', async () => {
    await pool();
    await mug.setTaxed(true);
    await expect(market.connect(alice).swapMugForTrail(e('1'), 0, deadline)).revertedWith('Unsupported MUG transfer');
    expect(await market.reserveMug()).eq(e('1000'));
    await mug.setTaxed(false);
    await mug.setCallback(addr, market.interface.encodeFunctionData('swapMugForTrail', [e('1'), 0, deadline]));
    await market.connect(alice).swapMugForTrail(e('1'), 0, deadline);
    expect(await mug.callbackBlocked()).eq(true);
    await solvent();
  });
  it('mixed trading, LP exits and game withdrawals preserve balances over many operations', async () => {
    await pool();
    await market.fundGameRewards(e('100'));
    await market.connect(bob).addLiquidity(e('100'), e('10000'), 0, 0, deadline);
    for (let i = 0; i < 12; i++) {
      await market.connect(alice).swapMugForTrail(e(String(i + 1)), 0, deadline);
      await market.connect(bob).swapTrailForMug(e(String((i + 1) * 23)), 0, deadline);
      const sig = await signature(alice.address, e('1'), i);
      await market.connect(alice).withdrawGame(alice.address, e('1'), i, deadline, sig);
      await solvent();
    }
    await market.connect(bob).removeLiquidity(await market.liquidityOf(bob.address), 0, 0, deadline);
    await market.removeLiquidity(await market.liquidityOf(owner.address), 0, 0, deadline);
    expect(await market.gameBacking()).eq(e('88'));
    expect(await market.totalLiquidity()).eq(1000);
    await solvent();
  });
});
