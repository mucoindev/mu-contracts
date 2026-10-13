const {expect}=require('chai');
const {ethers,network}=require('hardhat');
// Explicit local fork only. No live signer, key, or transaction broadcast.
(process.env.RUN_PORTFOLIO_FORK==='1'?describe:describe.skip)('Portfolio Avalanche fork',function(){
 this.timeout(240000);
 it('uses real native funding, LB swaps, MUG payment, V1 LP and wallet-only exits',async()=>{
  // Fork configured at startup: EDR 2.28 cannot reset a Cancun fork with storage overrides.
  await network.provider.send('evm_mine');
  const buyerAddress='0x1111111111111111111111111111111111111111';
  await network.provider.send('hardhat_impersonateAccount',[buyerAddress]);
  await network.provider.send('hardhat_setBalance',[buyerAddress,'0x3635c9adc5dea00000']);
  const buyer=await ethers.getSigner(buyerAddress),rewards={address:'0x2222222222222222222222222222222222222222'};
  const U='0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',W='0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',B='0x152b9d0FdC40C096757F570A51E494bd4b943E50',M='0xD036414fa2BCBb802691491E323BFf1348C5F4Ba',G='0xF7ed17f0Fb2B7C9D3DDBc9F0679b2e1098993e81',E='0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664';
  const R='0x18556DA13313f3532c54711497A8FedAC273220E',L='0x60aE616a2155Ee3d9A68541Ba4544862310933d4',A='0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
  const vault=await(await ethers.getContractFactory('MuPortfolio',buyer)).deploy(U,G,rewards.address,R,L,A,[W,B,M,G]);
  const quoter=new ethers.Contract('0x9A550a522BBaDFB69019b0432800Ed17855A51C3',['function findBestPathFromAmountIn(address[],uint128) view returns(tuple(address[] route,address[] pairs,uint256[] binSteps,uint8[] versions,uint128[] amounts,uint128[] virtualAmountsWithoutSlippage,uint128[] fees))'],buyer);
  const q=async(route,n)=>{const r=await quoter.findBestPathFromAmountIn(route,n);return{out:r.amounts[r.amounts.length-1],swap:{target:R,minOut:r.amounts[r.amounts.length-1]*95n/100n,data:'0x',path:{pairBinSteps:[...r.binSteps],versions:[...r.versions],tokenPath:[...r.route]}}};};
  const funding=await q([W,U],ethers.parseEther('2')); const budget=funding.out*99n/100n,fee=budget/1000n,amountA=(budget-fee)*60n/100n,amountB=budget-fee-amountA;
  const a=await q([U,W],amountA),b=await q([U,B],amountB),gold=await q([U,E,M,G],fee);
  const routeResponse=await fetch(`https://aggregator-api.kyberswap.com/avalanche/api/v1/routes?tokenIn=${U}&tokenOut=${B}&amountIn=${amountB}&includedSources=traderjoe,traderjoe-v20,traderjoe-v21,traderjoe-v22,pharaoh,pharaoh-v2,pharaoh-v3,pharaoh-lb,blackhole-v2,blackhole-v4`);
  const route=(await routeResponse.json()).data;
  console.log('Aggregator sources',route.routeSummary.route.flat().map(r=>r.exchange));
  const buildResponse=await fetch('https://aggregator-api.kyberswap.com/avalanche/api/v1/route/build',{method:'POST',headers:{'content-type':'application/json','x-client-id':'mu-money-portfolio'},body:JSON.stringify({routeSummary:route.routeSummary,sender:vault.target,recipient:vault.target,slippageTolerance:200,source:'mu-money-portfolio'})});
  const built=await buildResponse.json(); if(built.code!==0)throw Error(JSON.stringify(built));
  expect(built.data.routerAddress.toLowerCase()).eq(A.toLowerCase());
  b.swap={target:A,minOut:BigInt(route.routeSummary.amountOut)*98n/100n,data:built.data.data,path:{pairBinSteps:[],versions:[],tokenPath:[]}};
  const block=await ethers.provider.getBlock('latest');
  const inputs=[{token:ethers.ZeroAddress,amount:ethers.parseEther('2'),swap:funding.swap},budget,'Real pool 60/40',[{token:W,amountIn:amountA,swap:a.swap},{token:B,amountIn:amountB,swap:b.swap}],gold.swap,true,[1,1,1],block.timestamp+600];
  await vault.open(...inputs,{value:ethers.parseEther('2')});
  const p=await vault.getPosition(1); expect(p.lp).greaterThan(0n); expect(p.feeMUG).greaterThan(0n);expect(p.reserveUSDC).greaterThan(0n);
  const token=new ethers.Contract(G,['function balanceOf(address) view returns(uint256)'],buyer); expect(await token.balanceOf(rewards.address)).eq(p.feeMUG);
  const pair=new ethers.Contract(p.pair,['function getReserves() view returns(uint112,uint112,uint32)','function token0() view returns(address)','function totalSupply() view returns(uint256)'],buyer);
  const reserves=await pair.getReserves(),supply=await pair.totalSupply(),first=(await pair.token0()).toLowerCase()===W.toLowerCase();
  const amountW=p.held[0]+reserves[first?0:1]*p.lp/supply,amountBTC=p.held[1]+reserves[first?1:0]*p.lp/supply;
  const outW=await q([W,U],amountW),outB=await q([B,U],amountBTC);
  await vault.cashOut(1,[outW.swap.path,outB.swap.path],[outW.swap.minOut,outB.swap.minOut],[1,1],1,(await ethers.provider.getBlock('latest')).timestamp+600);
  const closed=await vault.getPosition(1);expect(closed.exitKind).eq(1);expect(closed.proceeds).greaterThan(0n);
  const budget2=10000000n,fee2=budget2/1000n,amount2=budget2-fee2;
  const blackhole=(await(await fetch(`https://aggregator-api.kyberswap.com/avalanche/api/v1/routes?tokenIn=${U}&tokenOut=${W}&amountIn=${amount2}&includedSources=blackhole-v2,blackhole-v4`)).json()).data;
  expect(blackhole.routeSummary.route.flat().every(r=>r.exchange.startsWith('blackhole'))).eq(true);
  const blackBuild=await(await fetch('https://aggregator-api.kyberswap.com/avalanche/api/v1/route/build',{method:'POST',headers:{'content-type':'application/json','x-client-id':'mu-money-portfolio'},body:JSON.stringify({routeSummary:blackhole.routeSummary,sender:vault.target,recipient:vault.target,slippageTolerance:200,source:'mu-money-portfolio'})})).json();
  if(blackBuild.code!==0)throw Error(JSON.stringify(blackBuild));
  console.log('Second basket sources',blackhole.routeSummary.route.flat().map(r=>r.exchange));
  const usdc=new ethers.Contract(U,['function approve(address,uint256) returns(bool)'],buyer);await usdc.approve(vault.target,budget2);
  const feeQuote2=await q([U,E,M,G],fee2);
  await vault.open({token:U,amount:budget2,swap:funding.swap},budget2,'Blackhole holding',[{token:W,amountIn:amount2,swap:{target:A,minOut:BigInt(blackhole.routeSummary.amountOut)*98n/100n,data:blackBuild.data.data,path:{pairBinSteps:[],versions:[],tokenPath:[]}}}],feeQuote2.swap,false,[0,0,0],(await ethers.provider.getBlock('latest')).timestamp+600);
  expect((await vault.getPosition(2)).bought[0]).greaterThan(0n);
  await vault.withdrawInKind(2);expect((await vault.getPosition(2)).exitKind).eq(2);
 });
});

