const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
describe('MuPortfolio atomic wallet-owned cards', function () {
  it('publishes exactly the tested compiler artifact',async()=>{
    const fs=require('fs'),path=require('path'),{artifacts}=require('hardhat');
    const built=await artifacts.readArtifact('MuPortfolio'),published=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../release/portfolio/artifact.json')));
    expect(published.bytecode).eq(built.bytecode);expect(published.runtime).eq(built.deployedBytecode);expect(published.abi).deep.eq(built.abi);
  });
  async function fixture() {
    const [alice,bob,rewards] = await ethers.getSigners();
    const T = await ethers.getContractFactory('PortfolioToken');
    const [usdc,avax,btc,mug] = await Promise.all([T.deploy(),T.deploy(),T.deploy(),T.deploy()]);
    const S = await ethers.getContractFactory('PortfolioSwapMock'); const router=await S.deploy(), agg=await S.deploy();
    const lp=await (await ethers.getContractFactory('PortfolioLPMock')).deploy(avax.target,btc.target);
    const vault=await (await ethers.getContractFactory('MuPortfolio')).deploy(usdc.target,mug.target,rewards.address,router.target,lp.target,agg.target,[avax.target,btc.target,mug.target]);
    await usdc.mint(alice.address,1000000000n); await usdc.approve(vault.target,1000000000n);
    const path=(a,b)=>({pairBinSteps:[0],versions:[0],tokenPath:[a,b]});
    const quote=(a,b)=>({target:router.target,minOut:1n,data:'0x',path:path(a,b)});
    const budget=100000000n, fee=budget/1000n, net=budget-fee;
    const legs=[{token:avax.target,amountIn:net*60n/100n,swap:quote(usdc.target,avax.target)},{token:btc.target,amountIn:net*40n/100n,swap:quote(usdc.target,btc.target)}];
    const args=async(liquidity=false)=>[{token:usdc.target,amount:budget,swap:quote(usdc.target,mug.target)},budget,'My 60/40',structuredClone(legs),quote(usdc.target,mug.target),liquidity,liquidity?[1n,1n,1n]:[0n,0n,0n],await time.latest()+600];
    return{alice,bob,rewards,usdc,avax,btc,mug,router,agg,lp,vault,path,quote,budget,fee,net,legs,args};
  }
  it('records exact lots, cost, source, fee and timestamp in one transaction',async()=>{
    const f=await loadFixture(fixture); await expect(f.vault.open(...await f.args())).to.emit(f.vault,'Opened');
    const p=await f.vault.getPosition(1); expect(p.owner).eq(f.alice.address); expect(p.totalUSDC).eq(f.budget); expect(p.sourceAmount).eq(f.budget);
    expect(p.bought[0]).eq(f.legs[0].amountIn); expect(p.bought[1]).eq(f.legs[1].amountIn); expect(p.createdAt).greaterThan(0n);
    expect(await f.mug.balanceOf(f.rewards.address)).eq(f.fee); expect(await f.usdc.allowance(f.vault.target,f.router.target)).eq(0n);
  });
  it('rolls back the entire basket, fee and source transfer if any output fails',async()=>{
    const f=await loadFixture(fixture); const a=await f.args(); a[3][1].swap.minOut=f.budget;
    await expect(f.vault.open(...a)).reverted; expect(await f.vault.positionCount()).eq(0); expect(await f.usdc.balanceOf(f.alice.address)).eq(1000000000n); expect(await f.mug.balanceOf(f.rewards.address)).eq(0);
  });
  it('isolates repeated buys and prevents other wallets from withdrawing',async()=>{
    const f=await loadFixture(fixture); await f.vault.open(...await f.args()); await f.vault.open(...await f.args());
    await expect(f.vault.connect(f.bob).withdrawInKind(1)).revertedWith('owner/open');
    await f.vault.withdrawInKind(1); expect((await f.vault.getPosition(2)).held[0]).eq(f.legs[0].amountIn);
    await expect(f.vault.withdrawInKind(1)).revertedWith('owner/open'); expect(await f.vault.ownerPositionCount(f.alice.address)).eq(2);
  });
  it('holds pool receipts and unmatched allocation, then closes to USDC atomically',async()=>{
    const f=await loadFixture(fixture); await f.vault.open(...await f.args(true)); const p=await f.vault.getPosition(1);
    expect(p.lp).eq(f.legs[1].amountIn); expect(p.held[0]).eq(f.legs[0].amountIn-f.legs[1].amountIn);
    await f.vault.cashOut(1,[f.path(f.avax.target,f.usdc.target),f.path(f.btc.target,f.usdc.target)],[1,1],[1,1],f.net,await time.latest()+600);
    const closed=await f.vault.getPosition(1); expect(closed.proceeds).eq(f.net); expect(closed.exitKind).eq(1); expect(closed.lp).eq(0);
  });
  it('withdraws LP directly even when the swap router is unavailable',async()=>{
    const f=await loadFixture(fixture); await f.vault.open(...await f.args(true)); await f.router.setFail(true);
    await f.vault.withdrawInKind(1); const p=await f.vault.getPosition(1); expect(p.exitKind).eq(2); expect(p.exitedLp).greaterThan(0n);
    const pair=await ethers.getContractAt('PortfolioPoolMock',await f.lp.pair()); expect(await pair.balanceOf(f.alice.address)).eq(p.exitedLp);
  });
  it('records native funding and keeps conversion surplus assigned to its own card',async()=>{
    const f=await loadFixture(fixture); const a=await f.args(); a[0]={token:ethers.ZeroAddress,amount:f.budget+1000n,swap:f.quote(f.avax.target,f.usdc.target)};
    await f.vault.open(...a,{value:f.budget+1000n}); const p=await f.vault.getPosition(1); expect(p.sourceToken).eq(ethers.ZeroAddress); expect(p.totalUSDC).eq(f.budget+1000n); expect(p.reserveUSDC).eq(1000);
    const before=await f.usdc.balanceOf(f.alice.address); await f.vault.withdrawInKind(1); expect(await f.usdc.balanceOf(f.alice.address)).eq(before+1000n);
  });
  it('accepts aggregator execution only with exact input and output to the vault',async()=>{
    const f=await loadFixture(fixture); const a=await f.args(); const leg=a[3][0];
    leg.swap.target=f.agg.target; leg.swap.data=f.agg.interface.encodeFunctionData('aggregate',[f.usdc.target,f.avax.target,leg.amountIn,f.vault.target,leg.amountIn]);
    await f.vault.open(...a); expect(await f.usdc.allowance(f.vault.target,f.agg.target)).eq(0);
  });
  it('rejects redirected aggregator outputs and arbitrary call targets',async()=>{
    const f=await loadFixture(fixture); const a=await f.args(); const leg=a[3][0];
    leg.swap.target=f.agg.target; leg.swap.data=f.agg.interface.encodeFunctionData('aggregate',[f.usdc.target,f.avax.target,leg.amountIn,f.bob.address,leg.amountIn]);
    await expect(f.vault.open(...a)).revertedWith('aggregator output'); leg.swap.target=f.bob.address; await expect(f.vault.open(...a)).revertedWith('router');
  });
  it('rejects malformed allocations, duplicate assets, zero minimums and expired quotes',async()=>{
    const f=await loadFixture(fixture); let a=await f.args(); a[1]+=1n; await expect(f.vault.open(...a)).revertedWith('allocation');
    a=await f.args(); a[3][1].token=a[3][0].token; await expect(f.vault.open(...a)).revertedWith('duplicate');
    a=await f.args();a[3][0].swap.minOut=0;await expect(f.vault.open(...a)).revertedWith('trade');
    a=await f.args();a[7]=1;await expect(f.vault.open(...a)).revertedWith('deadline');
    a=await f.args();a[3][0].token=f.usdc.target;await expect(f.vault.open(...a)).revertedWith('unsupported');
  });
  it('rejects partially spent aggregator input and rolls back all prior legs on a bad fee',async()=>{
    const f=await loadFixture(fixture);let a=await f.args();const leg=a[3][0];leg.swap.target=f.agg.target;
    leg.swap.data=f.agg.interface.encodeFunctionData('aggregate',[f.usdc.target,f.avax.target,leg.amountIn-1n,f.vault.target,leg.amountIn]);
    await expect(f.vault.open(...a)).revertedWith('exact input');
    a=await f.args();a[4].minOut=f.budget;await expect(f.vault.open(...a)).reverted;
    expect(await f.vault.positionCount()).eq(0);expect(await f.avax.balanceOf(f.vault.target)).eq(0);expect(await f.usdc.balanceOf(f.alice.address)).eq(1000000000n);
  });
  it('rejects native value mismatches and excessive LP minimums without charging the fee',async()=>{
    const f=await loadFixture(fixture);let a=await f.args();await expect(f.vault.open(...a,{value:1})).revertedWith('native value');
    a=await f.args(true);a[6]=[1,1,f.budget];await expect(f.vault.open(...a)).revertedWith('LP output');expect(await f.mug.balanceOf(f.rewards.address)).eq(0);
  });
});
