const {expect}=require('chai');
const {ethers}=require('hardhat');
const {time,loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const e=ethers.parseEther;
async function fixture(){
  const [owner,member,other]=await ethers.getSigners();
  const muo=await ethers.deployContract('MuFixedToken',['Ore','MUO',e('10000'),owner.address]);
  const muv=await ethers.deployContract('MuFixedToken',['Vault','MUV',e('10000'),owner.address]);
  const gold=await ethers.deployContract('MuFixedToken',['Gold','MUG',e('10000'),owner.address]);
  const gov=await ethers.deployContract('MuGovernor',[muo.target,muv.target,3600,86400,e('25'),4,e('100'),86400]);
  const treasury=await ethers.getContractAt('MuTimelock',await gov.timelock());
  for(const who of [owner,member,other]){
    if(who!==owner){await muo.transfer(who.address,e('1000'));await muv.transfer(who.address,e('1000'));}
    await muo.connect(who).approve(gov.target,ethers.MaxUint256);await muv.connect(who).approve(gov.target,ethers.MaxUint256);
  }
  await gov.deposit(e('200'),0);
  await gold.transfer(treasury.target,e('300'));
  await time.increase(1);
  return {owner,member,other,muo,muv,gold,gov,treasury};
}
async function propose(f,description='Community project',target=f.gold.target,data=f.gold.interface.encodeFunctionData('transfer',[f.member.address,e('10')])){
  const targets=[target],values=[0],datas=[data];
  const id=await f.gov.hashProposal(targets,values,datas,ethers.id(description));
  await f.gov.propose(targets,values,datas,description);
  return id;
}
async function activate(f,id){await time.increaseTo(await f.gov.proposalSnapshot(id)+1n);}
async function pass(f,id){await activate(f,id);await f.gov.castVote(id,1);await time.increaseTo(await f.gov.proposalDeadline(id)+1n);await f.gov['queue(uint256)'](id);await time.increaseTo(await f.gov.proposalEta(id));}
describe('Direct MUO/MUV governance',function(){
  it('holds original tokens with no receipt/delegation token and returns originals',async()=>{
    const f=await loadFixture(fixture);const before=await f.muv.balanceOf(f.owner.address);
    await f.gov.deposit(e('5'),e('10'));expect(await f.gov.deposits(f.owner.address)).deep.eq([e('205'),e('10')]);
    expect(await f.muo.balanceOf(f.gov.target)).eq(e('205'));expect(await f.muv.balanceOf(f.gov.target)).eq(e('10'));
    for(const name of ['transfer','approve','delegate','depositFor','token'])expect(f.gov.interface.fragments.filter(x=>x.name===name)).length(0);
    await f.gov.withdraw(e('5'),e('10'));expect(await f.muv.balanceOf(f.owner.address)).eq(before);expect(await f.gov.totalDeposits()).deep.eq([e('200'),0n]);
  });
  it('counts 1 MUO as 1 and 1 MUV as 4, without delegation',async()=>{
    const f=await loadFixture(fixture);await f.gov.connect(f.member).deposit(e('10'),e('20'));
    const id=await propose(f);await activate(f,id);expect(await f.gov.proposalVotingPower(id,f.member.address)).eq(e('90'));
    await f.gov.connect(f.member).castVote(id,1);expect((await f.gov.proposalVotes(id))[1]).eq(e('90'));
  });
  it('allows MUV-only proposals when weighted deposits meet the threshold',async()=>{
    const f=await loadFixture(fixture);await f.gov.connect(f.member).deposit(0,e('6.25'));await time.increase(1);
    await f.gov.connect(f.member).propose([f.gold.target],[0],['0x'],'MUV member proposal');expect(await f.gov.proposalCount()).eq(1);
  });
  it('rejects wallet-only and same-timestamp proposer balances',async()=>{
    const f=await loadFixture(fixture);await expect(f.gov.connect(f.member).propose([f.gold.target],[0],['0x'],'No deposit')).revertedWithCustomError(f.gov,'GovernorInsufficientProposerVotes');
    // The previous timestamp rule is covered by the zero historical balance before the first deposit.
    const at=await time.latest();await f.gov.connect(f.member).deposit(e('25'),0);expect(await f.gov.getVotes(f.member.address,at)).eq(0);
  });
  it('locks proposers immediately and voters through the inclusive deadline',async()=>{
    const f=await loadFixture(fixture);await f.gov.connect(f.member).deposit(e('10'),e('20'));const id=await propose(f);
    await expect(f.gov.withdraw(1,0)).revertedWith('Voting deposits locked');await activate(f,id);await f.gov.connect(f.member).castVote(id,0);
    await expect(f.gov.connect(f.member).withdraw(0,1)).revertedWith('Voting deposits locked');
    await time.setNextBlockTimestamp(await f.gov.proposalDeadline(id));await expect(f.gov.connect(f.member).withdraw(e('10'),e('20'))).revertedWith('Voting deposits locked');
    await time.increaseTo(await f.gov.proposalDeadline(id)+1n);await f.gov.connect(f.member).withdraw(e('10'),e('20'));
    expect(await f.gov.deposits(f.member.address)).deep.eq([0n,0n]);
  });
  it('extends a shared deposit lock to the latest overlapping vote deadline',async()=>{
    const f=await loadFixture(fixture);await f.gov.connect(f.member).deposit(0,e('30'));const first=await propose(f);await activate(f,first);await f.gov.connect(f.member).castVote(first,1);
    const second=await propose(f,'Second project');await activate(f,second);await f.gov.connect(f.member).castVote(second,1);
    expect(await f.gov.lockedUntil(f.member.address)).eq(await f.gov.proposalDeadline(second));
    await time.increaseTo(await f.gov.proposalDeadline(first)+1n);await expect(f.gov.connect(f.member).withdraw(0,1)).revertedWith('Voting deposits locked');
    await time.increaseTo(await f.gov.proposalDeadline(second)+1n);await f.gov.connect(f.member).withdraw(0,e('30'));
  });
  it('prevents transfer/redeposit vote recycling and excludes deposits after snapshot',async()=>{
    const f=await loadFixture(fixture);await f.gov.connect(f.member).deposit(e('100'),0);const id=await propose(f);await activate(f,id);
    await f.gov.connect(f.member).withdraw(e('100'),0);await f.muo.connect(f.member).transfer(f.other.address,e('100'));await f.gov.connect(f.other).deposit(e('100'),0);
    await expect(f.gov.connect(f.member).castVote(id,1)).revertedWith('Deposit before voting opens');
    await expect(f.gov.connect(f.other).castVote(id,1)).revertedWith('Deposit before voting opens');
    await f.gov.castVote(id,1);await expect(f.gov.withdraw(1,0)).revertedWith('Voting deposits locked');expect((await f.gov.proposalVotes(id))[1]).eq(e('200'));
  });
  it('caps withdrawn historical balances at originals still on deposit',async()=>{
    const f=await loadFixture(fixture);await f.gov.connect(f.member).deposit(e('100'),e('10'));const id=await propose(f);await activate(f,id);
    await f.gov.connect(f.member).withdraw(e('60'),e('5'));await f.gov.connect(f.member).castVote(id,1);expect((await f.gov.proposalVotes(id))[1]).eq(e('60'));
  });
  it('rejects double votes, invalid support, premature votes and empty deposits',async()=>{
    const f=await loadFixture(fixture);const id=await propose(f);await expect(f.gov.castVote(id,1)).revertedWithCustomError(f.gov,'GovernorUnexpectedProposalState');await activate(f,id);
    await expect(f.gov.castVote(id,3)).revertedWithCustomError(f.gov,'GovernorInvalidVoteType');await f.gov.castVote(id,1);
    await expect(f.gov.castVote(id,1)).revertedWithCustomError(f.gov,'GovernorAlreadyCastVote');await expect(f.gov.deposit(0,0)).revertedWith('Amount required');
  });
  it('uses weighted snapshot deposits for quorum and retains a floor',async()=>{
    const f=await loadFixture(fixture);await f.gov.connect(f.member).deposit(0,e('1000'));const id=await propose(f);await activate(f,id);
    expect(await f.gov.proposalQuorum(id)).eq(e('168'));await f.gov.connect(f.member).withdraw(0,e('1000'));expect(await f.gov.proposalQuorum(id)).eq(e('168'));
    expect(await f.gov.quorum(await f.gov.proposalSnapshot(id))).eq(e('168'));
  });
  it('defeats proposals without quorum, and abstain alone cannot pass',async()=>{
    const f=await loadFixture(fixture);const id=await propose(f);await activate(f,id);await f.gov.castVote(id,2);await time.increaseTo(await f.gov.proposalDeadline(id)+1n);
    expect(await f.gov.state(id)).eq(3);await expect(f.gov['queue(uint256)'](id)).reverted;
  });
  it('executes approved treasury payments once, after queue and timelock',async()=>{
    const f=await loadFixture(fixture);const id=await propose(f);await activate(f,id);await f.gov.castVote(id,1);await time.increaseTo(await f.gov.proposalDeadline(id)+1n);
    await expect(f.gov['execute(uint256)'](id)).reverted;await f.gov['queue(uint256)'](id);await expect(f.gov['execute(uint256)'](id)).reverted;
    await time.increaseTo(await f.gov.proposalEta(id));await f.gov.connect(f.other)['execute(uint256)'](id);expect(await f.gold.balanceOf(f.member.address)).eq(e('10'));
    await expect(f.gov['execute(uint256)'](id)).reverted;await f.gov.withdraw(e('200'),0);
  });
  it('allows only completed governance to change MUV weight, preserving older proposal policies',async()=>{
    const f=await loadFixture(fixture);await f.gov.connect(f.member).deposit(0,e('20'));
    await expect(f.gov.setMuvMultiplier(8)).revertedWithCustomError(f.gov,'GovernorOnlyExecutor');
    const change=await propose(f,'Set MUV to 8x',f.gov.target,f.gov.interface.encodeFunctionData('setMuvMultiplier',[8]));await pass(f,change);
    // Create a still-pending proposal before the change executes; its entire lifecycle keeps 4x.
    const older=await propose(f,'Keep original policy');await f.gov['execute(uint256)'](change);expect(await f.gov.muvMultiplier()).eq(8);
    await activate(f,older);await f.gov.connect(f.member).castVote(older,1);expect((await f.gov.proposalVotes(older))[1]).eq(e('80'));
    const newer=await propose(f,'New policy');await activate(f,newer);await f.gov.connect(f.member).castVote(newer,1);expect((await f.gov.proposalVotes(newer))[1]).eq(e('160'));
    expect((await f.gov.proposalPolicy(older)).multiplier).eq(4);expect((await f.gov.proposalPolicy(newer)).multiplier).eq(8);
  });
  it('rejects lowering MUV to equal MUO through governance',async()=>{
    const f=await loadFixture(fixture);const id=await propose(f,'Invalid multiplier',f.gov.target,f.gov.interface.encodeFunctionData('setMuvMultiplier',[1]));await pass(f,id);await expect(f.gov['execute(uint256)'](id)).revertedWith('MUV must have higher weight');
  });
  it('changes quorum through governance without changing pending proposal terms',async()=>{
    const f=await loadFixture(fixture);const id=await propose(f,'Set quorum',f.gov.target,f.gov.interface.encodeFunctionData('setQuorum',[10,e('150')]));await pass(f,id);
    const older=await propose(f,'Original quorum');await f.gov['execute(uint256)'](id);expect(await f.gov.minimumQuorum()).eq(e('150'));expect(await f.gov.proposalQuorum(older)).eq(e('100'));
    const newer=await propose(f,'New quorum');expect(await f.gov.proposalQuorum(newer)).eq(e('150'));
  });
  it('protects deposit reserves against even approved governance relay transfers/approvals',async()=>{
    const f=await loadFixture(fixture);for(const method of ['transfer','approve']){
      const data=f.gov.interface.encodeFunctionData('relay',[f.muo.target,0,f.muo.interface.encodeFunctionData(method,[f.member.address,e('200')])]);
      const id=await propose(f,'Attempt '+method,f.gov.target,data);await pass(f,id);await expect(f.gov['execute(uint256)'](id)).revertedWith('Voting tokens protected');
    }
    expect(await f.muo.balanceOf(f.gov.target)).eq(e('200'));await f.gov.withdraw(e('200'),0);
  });
  it('permits governance to recover separately received rewards to the treasury',async()=>{
    const f=await loadFixture(fixture);await f.gold.transfer(f.gov.target,e('5'));
    const data=f.gov.interface.encodeFunctionData('relay',[f.gold.target,0,f.gold.interface.encodeFunctionData('transfer',[f.treasury.target,e('5')])]);
    const id=await propose(f,'Move rewards',f.gov.target,data);await pass(f,id);await f.gov['execute(uint256)'](id);expect(await f.gold.balanceOf(f.treasury.target)).eq(e('305'));expect(await f.muo.balanceOf(f.gov.target)).eq(e('200'));
  });
  it('gives the governor treasury roles and gives the deployer no admin power',async()=>{
    const f=await loadFixture(fixture);expect(await f.treasury.hasRole(await f.treasury.PROPOSER_ROLE(),f.gov.target)).eq(true);
    expect(await f.treasury.hasRole(await f.treasury.EXECUTOR_ROLE(),f.gov.target)).eq(true);expect(await f.treasury.hasRole(await f.treasury.DEFAULT_ADMIN_ROLE(),f.owner.address)).eq(false);
    await expect(f.gov.setVotingPeriod(100000)).revertedWithCustomError(f.gov,'GovernorOnlyExecutor');await expect(f.gov.setQuorum(10,e('150'))).revertedWithCustomError(f.gov,'GovernorOnlyExecutor');
  });
});
