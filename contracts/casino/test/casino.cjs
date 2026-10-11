const { expect } = require('chai');
const { ethers, artifacts } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const E = ethers.parseEther;
async function setup() {
  const [owner, alice, bob, rewards] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory('MockMUG')).deploy();
  const vrf = await (await ethers.getContractFactory('MockCoordinator')).deploy();
  const c = await (await ethers.getContractFactory('MuCasino')).deploy(token.target, rewards.address, vrf.target, 1, ethers.id('lane'));
  for (const who of [owner, alice, bob]) { await token.transfer(who.address, E('1000')); await token.connect(who).approve(c.target, ethers.MaxUint256); }
  return { c, token, vrf, owner, alice, bob, rewards };
}
async function active() { const s = await setup(); await s.c.setPaused(false); return s; }
async function backed() { const s = await active(); await s.c.fundBankroll(E('100')); await s.c.connect(s.alice).deposit(E('10')); return s; }
describe('MUG casino backing and VRF', function () {
  it('starts paused and runtime matches the exported-verification strategy', async () => {
    const { c, alice, owner, token, rewards, vrf } = await loadFixture(setup);
    expect(await c.paused()).eq(true);
    await expect(c.connect(alice).deposit(E('1'))).revertedWith('New play paused');
    await expect(c.connect(alice).setPaused(false)).revertedWith('Owner only');
    expect(await ethers.provider.getCode(c.target)).eq((await artifacts.readArtifact('MuCasino')).deployedBytecode);
    // The exported artifact identifies an already registered deployment. Its
    // executable code is current, but its source-metadata IPFS digest predates
    // the LF checkout rule. Preserve that exact deployment artifact and test it
    // independently; never loosen the Worker's full-runtime hash verification.
    const exported = require('../../../release/casino/MuCasino.json');
    const historical = await new ethers.ContractFactory(exported.abi, exported.bytecode, owner)
      .deploy(token.target, rewards.address, vrf.target, 1, ethers.id('lane'));
    const historicalCode = await ethers.provider.getCode(historical.target);
    expect(ethers.keccak256(historicalCode)).eq(exported.deployedBytecodeHash);
    // Permit ONLY the 32-byte IPFS source digest in the exact solc 0.8.28 CBOR
    // trailer to differ. Every opcode and remaining metadata byte must match.
    const trailer = /a2646970667358221220[0-9a-f]{64}64736f6c634300081c0033$/;
    const freshCode = await ethers.provider.getCode(c.target);
    expect(freshCode).match(trailer);
    expect(historicalCode).match(trailer);
    expect(freshCode.replace(trailer, 'SOURCE_METADATA')).eq(historicalCode.replace(trailer, 'SOURCE_METADATA'));
  });
  it('redeems the exact deposit even while paused; rejects overdrafts', async () => {
    const { c, token, alice } = await loadFixture(active);
    await c.connect(alice).deposit(E('1.23')); await c.setPaused(true);
    expect(await c.credits(alice.address)).eq(E('1.23'));
    await expect(c.connect(alice).withdraw(E('1.24'))).revertedWith('Insufficient credits');
    await expect(c.connect(alice).withdraw(E('1.23'))).changeTokenBalance(token, alice, E('1.23'));
    expect(await c.totalCredits()).eq(0);
  });
  it('cannot distribute deposits or bankroll principal', async () => {
    const { c } = await loadFixture(backed);
    expect(await c.availableProfit()).eq(0);
    await expect(c.sendProfitToRewards()).revertedWith('No earned profit');
  });
  it('allows only unreserved owner capital to be withdrawn and keeps losses out of profit', async () => {
    const { c, vrf, alice, token, owner } = await loadFixture(backed);
    await expect(c.connect(alice).withdrawBankroll(1)).revertedWith('Owner only');
    await c.connect(alice).play(0, 0, E('1'));
    await expect(c.withdrawBankroll(E('100'))).revertedWith('Player funds reserved');
    await c.withdrawBankroll(E('99'));
    expect(await token.balanceOf(c.target)).gte(await c.liabilities());
    await vrf.fulfill(1, 0); await c.settleBet(1);
    await expect(c.withdrawBankroll(E('0.04'))).changeTokenBalance(token, owner, E('0.04'));
    expect(await c.bankrollPrincipal()).eq(E('0.96'));
    expect(await c.availableProfit()).eq(0);
    await expect(c.withdrawBankroll(1)).revertedWith('Player funds reserved');
  });
  it('rejects a bet when no bankroll covers the possible win, atomically', async () => {
    const { c, alice } = await loadFixture(active);
    await c.connect(alice).deposit(E('1'));
    await expect(c.connect(alice).play(0, 0, E('1'))).revertedWith('Bankroll too small');
    expect(await c.credits(alice.address)).eq(E('1'));
  });
  it('only accepts coordinator callbacks, prevents repeat/reroll and settlement replay', async () => {
    const { c, vrf, alice, bob } = await loadFixture(backed);
    await c.connect(alice).play(0, 0, E('1'));
    await expect(c.rawFulfillRandomWords(1, [0])).revertedWith('Coordinator only');
    await expect(c.connect(alice).play(1, 0, E('1'))).revertedWith('Settle previous bet');
    await expect(c.settleBet(1)).revertedWith('Bet not ready');
    await vrf.fulfill(1, 0); await vrf.fulfill(1, 1); // first seed is final
    await c.setPaused(true); await c.connect(bob).settleBet(1);
    expect(await c.credits(alice.address)).eq(E('10.96'));
    expect(await c.reservedPayouts()).eq(0);
    await expect(c.settleBet(1)).revertedWith('Bet not ready');
  });
  it('keeps pending max payouts protected and sends only realized surplus', async () => {
    const { c, vrf, alice, token, rewards } = await loadFixture(backed);
    await c.connect(alice).play(0, 0, E('1'));
    expect(await c.reservedPayouts()).eq(E('1.96'));
    expect(await c.availableProfit()).eq(0);
    await vrf.fulfill(1, 1); await c.settleBet(1);
    expect(await c.availableProfit()).eq(E('1'));
    await expect(c.sendProfitToRewards()).changeTokenBalance(token, rewards, E('1'));
    expect(await c.totalRewardsSent()).eq(E('1'));
    expect(await token.balanceOf(c.target)).gte(await c.liabilities());
    await expect(c.sendProfitToRewards()).revertedWith('No earned profit');
  });
  it('recoups bankroll losses before distributing later profit', async () => {
    const { c, vrf, alice } = await loadFixture(backed);
    await c.connect(alice).play(0, 0, E('1')); await vrf.fulfill(1, 0); await c.settleBet(1);
    expect(await c.availableProfit()).eq(0);
    await c.connect(alice).play(0, 0, E('1')); await vrf.fulfill(2, 1); await c.settleBet(2);
    expect(await c.availableProfit()).eq(E('0.04'));
  });
  it('supports both dice ranges and out-of-order fulfillments across wallets', async () => {
    const { c, vrf, alice, bob } = await loadFixture(backed);
    await c.connect(bob).deposit(E('10'));
    await c.connect(alice).play(1, 0, E('1')); await c.connect(bob).play(1, 1, E('1'));
    await vrf.fulfill(2, 5); await vrf.fulfill(1, 2);
    await c.settleBet(2); await c.settleBet(1);
    expect(await c.credits(alice.address)).eq(E('10.96')); expect(await c.credits(bob.address)).eq(E('10.96'));
  });
  it('closes sales before randomness, selects ticket ranges correctly and preserves the entire pending pot', async () => {
    const { c, vrf, alice, bob } = await loadFixture(backed);
    await c.connect(bob).deposit(E('2')); await c.openRound();
    await c.connect(alice).buyTickets(1, 2); await c.connect(bob).buyTickets(1, 3);
    expect(await c.lotteryPots()).eq(E('0.5')); expect(await c.availableProfit()).eq(0);
    await expect(c.requestDraw(1)).revertedWith('Draw unavailable');
    await time.increaseTo((await c.rounds(1)).closesAt);
    await expect(c.connect(alice).buyTickets(1, 1)).revertedWith('Sales closed');
    await c.requestDraw(1); await expect(c.requestDraw(1)).revertedWith('Draw unavailable');
    await vrf.fulfill(1, 2); await c.settleRound(1);
    expect((await c.rounds(1)).winner).eq(bob.address); expect((await c.rounds(1)).winningTicket).eq(3);
    expect(await c.credits(bob.address)).eq(E('2.15')); expect(await c.availableProfit()).eq(E('0.05'));
    await expect(c.settleRound(1)).revertedWith('Draw not ready');
    await c.openRound(); await expect(c.connect(alice).buyTickets(1, 1)).revertedWith('Sales closed');
  });
  it('handles an empty round without charging randomness', async () => {
    const { c, vrf } = await loadFixture(active); await c.openRound();
    await time.increase(86400); await c.requestDraw(1);
    expect((await c.rounds(1)).settled).eq(true); expect(await vrf.counter()).eq(0); await c.openRound();
  });
  it('exposes exact wallet ticket ranges across interleaved purchases and past draws', async () => {
    const { c, alice, bob, vrf } = await loadFixture(backed);
    await c.connect(bob).deposit(E('2')); await c.openRound();
    await c.connect(alice).buyTickets(1, 2); // 1..2
    await c.connect(bob).buyTickets(1, 3); // 3..5
    await c.connect(alice).buyTickets(1, 1); // 6
    const [first, last, total] = await c.getTicketRanges(1, alice.address, 0, 100);
    expect([...first]).deep.eq([1n,6n]); expect([...last]).deep.eq([2n,6n]); expect(total).eq(2);
    const second = await c.getTicketRanges(1, alice.address, 1, 1);
    expect([...second[0]]).deep.eq([6n]); expect(second[2]).eq(2);
    expect([...(await c.getTicketRanges(1, alice.address, 2, 100))[0]]).deep.eq([]);
    await expect(c.getTicketRanges(1, alice.address, 0, 101)).revertedWith('Page limit');
    await time.increase(86400); await c.requestDraw(1); await vrf.fulfill(1, 5); await c.settleRound(1); await c.openRound();
    expect((await c.rounds(1)).winningTicket).eq(6);
    expect([...(await c.getTicketRanges(1, alice.address, 0, 100))[0]]).deep.eq([1n,6n]);
    expect([...(await c.getTicketRanges(2, alice.address, 0, 100))[0]]).deep.eq([]);
  });
  it('preserves solvency through varied games, redemptions and profit sweeps', async () => {
    const { c, vrf, alice, token } = await loadFixture(backed);
    for (let i = 1; i <= 24; i++) {
      await c.connect(alice).play(i % 2, i % 2, E('0.1'));
      expect(await token.balanceOf(c.target)).gte(await c.liabilities());
      await vrf.fulfill(i, i * 7919); await c.settleBet(i);
      if (await c.availableProfit() > 0n) await c.sendProfitToRewards();
      expect(await token.balanceOf(c.target)).gte(await c.liabilities());
    }
    await c.connect(alice).withdraw(await c.credits(alice.address));
    expect(await c.totalCredits()).eq(0);
  });
});
