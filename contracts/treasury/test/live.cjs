const {expect}=require('chai');
const {ethers,artifacts}=require('hardhat');
const {loadFixture,time}=require('@nomicfoundation/hardhat-network-helpers');
const unit=ethers.parseEther;
async function fixture(){
 const [owner,buyer,other]=await ethers.getSigners();
 const T=await ethers.getContractFactory('TestToken');
 const muv=await T.deploy(18),mu=await T.deploy(18),usdc=await T.deploy(6),wrapped=await T.deploy(18),btc=await T.deploy(8);
 const oracle=await(await ethers.getContractFactory('TestMuPriceOracle')).deploy();
 const P=await ethers.getContractFactory('TestPricePair');
 const nativePair=await P.deploy(mu.target,wrapped.target,unit('10000'),unit('20'));
 const bitcoinPair=await P.deploy(btc.target,mu.target,200000n,unit('10000'));
 const router=await(await ethers.getContractFactory('TestRouter')).deploy();
 const t=await(await ethers.getContractFactory('LiveMuTreasury')).deploy(owner.address,muv.target,mu.target,router.target,wrapped.target,oracle.target,usdc.target,btc.target,nativePair.target,bitcoinPair.target);
 await muv.mint(owner.address,unit('10'));await muv.approve(t.target,unit('10'));await t.fundInventory(unit('10'));
 await usdc.mint(buyer.address,1000000000n);await usdc.connect(buyer).approve(t.target,1000000000n);
 await t.setSaleOpen(true);
 return {owner,buyer,other,t,muv,mu,usdc,wrapped,btc,oracle,nativePair,bitcoinPair};
}
describe('Live MU Gold inventory pricing',function(){
 it('exports exactly the tested live bytecode',async()=>{const a=await artifacts.readArtifact('LiveMuTreasury');const shipped=require('../../../release/treasury/live-artifact.json');expect(shipped.bytecode).eq(a.bytecode);expect(shipped.runtime).eq(a.deployedBytecode);expect(shipped.abi).deep.eq(a.abi);});
 it('uses 1 MUG USD value less 25% without published references',async()=>{const f=await loadFixture(fixture);expect(await f.t.pricingVersion()).eq(2);expect(await f.t.referencePrice(f.usdc.target)).eq(8000000);expect(await f.t.quote(f.usdc.target,unit('1'))).eq(6000000);});
 it('tracks the existing oracle on every quote and purchase',async()=>{const f=await loadFixture(fixture);await f.oracle.setPrices(unit('12'),unit('0.02'));expect(await f.t.quote(f.usdc.target,unit('1'))).eq(9000000);await f.t.connect(f.buyer).buy(f.usdc.target,unit('1'),9000000,await f.t.revision(),(await time.latest())+600);expect(await f.muv.balanceOf(f.buyer.address)).eq(unit('1'));expect(await f.usdc.balanceOf(f.t.target)).eq(9000000);});
 it('converts AVAX and BTC.b with correct decimals and either pair ordering',async()=>{const f=await loadFixture(fixture);expect(await f.t.quote(f.wrapped.target,unit('1'))).eq(unit('0.6'));expect(await f.t.quote(f.btc.target,unit('1'))).eq(6000);});
 it('rejects a price rise beyond the buyer cap without transferring funds',async()=>{const f=await loadFixture(fixture);await f.oracle.setPrices(unit('12'),unit('0.02'));await expect(f.t.connect(f.buyer).buy(f.usdc.target,unit('1'),6000000,await f.t.revision(),(await time.latest())+600)).revertedWith('Payment exceeds limit');expect(await f.t.totalSold()).eq(0);});
 it('charges the lower execution price and refunds native excess',async()=>{const f=await loadFixture(fixture);const before=await ethers.provider.getBalance(f.buyer.address);const tx=await f.t.connect(f.buyer).buyNative(unit('1'),await f.t.revision(),(await time.latest())+600,{value:unit('0.7')});const receipt=await tx.wait();expect(await f.wrapped.balanceOf(f.t.target)).eq(unit('0.6'));expect(await ethers.provider.getBalance(f.t.target)).eq(0);expect(before-await ethers.provider.getBalance(f.buyer.address)-receipt.fee).eq(unit('0.6'));});
 it('keeps discount governance and rejects stale sale terms',async()=>{const f=await loadFixture(fixture);const rev=await f.t.revision();await f.t.setDiscount(1000);expect(await f.t.quote(f.usdc.target,unit('1'))).eq(7200000);await expect(f.t.connect(f.buyer).buy(f.usdc.target,unit('1'),9000000,rev,(await time.latest())+600)).revertedWith('Terms changed; refresh quote');});
 it('blocks disabled assets, zero oracle prices and empty conversion pools',async()=>{const f=await loadFixture(fixture);await f.t.disableAsset(f.usdc.target);await expect(f.t.quote(f.usdc.target,unit('1'))).revertedWith('Asset disabled');await f.oracle.setPrices(0,unit('0.02'));await expect(f.t.quote(f.btc.target,unit('1'))).revertedWith('MU Gold price unavailable');await f.oracle.setPrices(unit('8'),unit('0.02'));await f.nativePair.setReserves(0,unit('1'));await expect(f.t.quote(f.wrapped.target,unit('1'))).revertedWith('Pricing pool empty');});
 it('retains inventory, expiry and ownership checks',async()=>{const f=await loadFixture(fixture);await expect(f.t.connect(f.other).setAssetEnabled(f.usdc.target,false)).revertedWithCustomError(f.t,'OwnableUnauthorizedAccount');await expect(f.t.connect(f.buyer).buy(f.usdc.target,unit('11'),100000000,await f.t.revision(),(await time.latest())+600)).revertedWith('Insufficient MUV inventory');await expect(f.t.connect(f.buyer).buy(f.usdc.target,unit('1'),6000000,await f.t.revision(),1)).revertedWith('Quote expired');});
});
