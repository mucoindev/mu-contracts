const {expect}=require('chai');
const {ethers,network}=require('hardhat');
const {time}=require('@nomicfoundation/hardhat-network-helpers');
// Local fork only: never signs or broadcasts to Avalanche.
(process.env.RUN_TREASURY_FORK==='1'?describe:describe.skip)('Avalanche local-fork integration',function(){
 this.timeout(180000);
 it('funds real MUV, buys with native AVAX and USDC, and deploys/removes real LFJ LP',async()=>{
  console.log('Initializing local fork');
  await network.provider.request({method:'hardhat_reset',params:[{forking:{jsonRpcUrl:'https://api.avax.network/ext/bc/C/rpc'}}]});
  await network.provider.send('evm_mine');
  console.log('Local fork ready');
  const team='0xF243d79910cBd70a0eaF405b08E80065a67D5e14',muvAddress='0xdbA664085ae73CF4E4eb57954BDC88Be297B1f09',muAddress='0xD036414fa2BCBb802691491E323BFf1348C5F4Ba',usdcAddress='0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',wavax='0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',routerAddress='0x60aE616a2155Ee3d9A68541Ba4544862310933d4';
  await network.provider.request({method:'hardhat_impersonateAccount',params:[team]});
  await network.provider.send('hardhat_setBalance',[team,'0x3635c9adc5dea00000']);
  console.log('Local impersonated account ready');
  const buyerAddress='0x1111111111111111111111111111111111111111';
  await network.provider.request({method:'hardhat_impersonateAccount',params:[buyerAddress]});
  await network.provider.send('hardhat_setBalance',[buyerAddress,'0x3635c9adc5dea00000']);
  const owner=await ethers.getSigner(team),buyer=await ethers.getSigner(buyerAddress);
  const tokenAbi=['function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'];
  const muv=new ethers.Contract(muvAddress,tokenAbi,owner),usdc=new ethers.Contract(usdcAddress,tokenAbi,buyer);
  const router=new ethers.Contract(routerAddress,['function getAmountsOut(uint256,address[]) view returns(uint256[])','function swapExactAVAXForTokens(uint256,address[],address,uint256) payable returns(uint256[])'],buyer);
  const t=await(await ethers.getContractFactory('MuTreasury',owner)).deploy(team,muvAddress,muAddress,routerAddress,wavax);
  console.log('Local treasury deployed');
  await muv.approve(t.target,ethers.parseEther('100'));await t.fundInventory(ethers.parseEther('100'));
  const until=(await time.latest())+3600;
  await t.setReference(wavax,ethers.parseEther('0.6'),until);await t.setReference(usdcAddress,6000000,until);await t.setSaleOpen(true);
  const before=await muv.balanceOf(buyer.address);
  await t.connect(buyer).buyNative(ethers.parseEther('1'),await t.revision(),(await time.latest())+600,{value:ethers.parseEther('0.45')});
  await router.swapExactAVAXForTokens(1,[wavax,usdcAddress],buyer.address,(await time.latest())+600,{value:ethers.parseEther('2')});
  await usdc.approve(t.target,4500000);await t.connect(buyer).buy(usdcAddress,ethers.parseEther('1'),4500000,await t.revision(),(await time.latest())+600);
  expect((await muv.balanceOf(buyer.address))-before).eq(ethers.parseEther('2'));expect(await usdc.balanceOf(t.target)).eq(4500000);
  const acquired=(await router.getAmountsOut(1000000,[usdcAddress,wavax,muAddress]))[2];
  await t.deployLiquidity(usdcAddress,2000000,1000000,true,acquired*99n/100n,1,1,(await time.latest())+600);
  const pair=new ethers.Contract('0xCf0A8A98eFE6Af5865f10b609D710CbFBe41514a',tokenAbi,buyer);
  const lp=await pair.balanceOf(t.target);expect(lp).gt(0);
  await t.removeLiquidity(usdcAddress,lp,1,1,(await time.latest())+600);expect(await pair.balanceOf(t.target)).eq(0);
 });
});
