// Fuji TESTNET deploy of MuDogy with mock Pups / MUG / MUO / MUV.
// NOT RUN. Nothing has been deployed anywhere.
//
// Dry run on the in-process Hardhat chain (deploys nothing real, does a demo birth):
//   npx hardhat run scripts/deploy-fuji.cjs
// Fuji (needs a funded test key and an explicit confirmation):
//   FUJI_PRIVATE_KEY=0x... CONFIRM_FUJI_DEPLOY=yes npx hardhat run scripts/deploy-fuji.cjs --network fuji
//
// Optional env:
//   DOGY_OWNER                  admin address (default: deployer)
//   DOGY_TREASURY               MUG receiver (default: deployer)
//   DOGY_PRICE_MUG              birth price in whole MUG (default 10)
//   DOGY_REROLL_BASE_MUG        first reroll cost in whole MUG (default 2)
//   DOGY_REROLL_STEP_MUG        whole MUG each reroll of a table adds to its last (default 1: 2, 3, 4 ...)
//   DOGY_BASE_URI               metadata base (default: contract default, the MAINNET
//                               path; set a testnet path so ids do not collide)
//   TESTERS                     comma-separated addresses that get mock Pups + tokens
//   DEMO_BIRTH=1                also birth, reroll and lock one Dogy (always on the dry run)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const FUJI = 43113n;
const LOCAL = 31337n;
const SAFE = "safeTransferFrom(address,address,uint256)";
const E = (n) => ethers.parseUnits(String(n), 18);

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== FUJI && chainId !== LOCAL) {
    throw new Error(`Refusing to run on chainId ${chainId}: this script is for Fuji (43113) or a local dry run only.`);
  }
  if (chainId === FUJI && process.env.CONFIRM_FUJI_DEPLOY !== "yes") {
    throw new Error("Set CONFIRM_FUJI_DEPLOY=yes to deploy to Fuji testnet.");
  }
  const dryRun = chainId === LOCAL;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account (set FUJI_PRIVATE_KEY).");

  const owner = process.env.DOGY_OWNER || deployer.address;
  const treasury = process.env.DOGY_TREASURY || deployer.address;
  const price = E(process.env.DOGY_PRICE_MUG || "10");
  const rerollBase = E(process.env.DOGY_REROLL_BASE_MUG || "2");
  const rerollStep = E(process.env.DOGY_REROLL_STEP_MUG || "1");
  const baseURI = process.env.DOGY_BASE_URI || "";
  const testers = (process.env.TESTERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of [owner, treasury, ...testers]) if (!ethers.isAddress(a)) throw new Error(`Bad address: ${a}`);

  console.log(`${dryRun ? "DRY RUN (in-process hardhat chain)" : "FUJI TESTNET"} deployer ${deployer.address}`);

  // --- mocks (testnet stand-ins for the real Avalanche contracts)
  const Mintpeg = await ethers.getContractFactory("MockMintpeg");
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const pups = await (await Mintpeg.deploy("MU Pups (Fuji mock)", "MUPUP")).waitForDeployment();
  const mug = await (await ERC20.deploy("MU Gold (Fuji mock)", "MUG")).waitForDeployment();
  const muo = await (await ERC20.deploy("MU Ore (Fuji mock)", "MUO")).waitForDeployment();
  const muv = await (await ERC20.deploy("MU Vault (Fuji mock)", "MUV")).waitForDeployment();

  // --- MuDogy
  const Dogy = await ethers.getContractFactory("MuDogy");
  const dogy = await (
    await Dogy.deploy(owner, pups, mug, muo, muv, treasury, price, rerollBase, rerollStep, baseURI)
  ).waitForDeployment();

  // --- test balances. Deployer: Pups #0-2 (Edition 1) and boundary ids incl. #349 (blocked).
  await (await pups.mint(deployer.address, 3)).wait();
  for (const id of [99, 100, 101, 200, 348, 349]) await (await pups.mintId(deployer.address, id)).wait();
  const holders = [deployer.address, ...testers];
  for (const a of holders) {
    await (await mug.mint(a, E(1000))).wait();
    await (await muo.mint(a, E(30))).wait(); // Silver Collar tier
    await (await muv.mint(a, E(12))).wait(); // Radiant Aura tier
  }
  let nextTesterPup = 10;
  for (const a of testers) {
    for (let k = 0; k < 3; k++) await (await pups.mintId(a, nextTesterPup++)).wait();
  }

  const out = {
    network: dryRun ? "hardhat" : "fuji",
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    owner,
    treasury,
    price: price.toString(),
    rerollBase: rerollBase.toString(),
    rerollStep: rerollStep.toString(),
    baseURI: baseURI || "(contract default)",
    contracts: {
      MuDogy: dogy.target,
      MockPups: pups.target,
      MockMUG: mug.target,
      MockMUO: muo.target,
      MockMUV: muv.target,
    },
  };
  console.log(JSON.stringify(out, null, 2));

  // --- demo: the real user flow
  if (dryRun || process.env.DEMO_BIRTH === "1") {
    console.log("\nDemo birth: approve MUG, then Pups.safeTransferFrom(holder, MuDogy, 0)");
    await (await mug.approve(dogy, price)).wait();
    const rcpt = await (await pups[SAFE](deployer.address, dogy, 0)).wait();
    const ev = rcpt.logs.map((l) => { try { return dogy.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Birth");
    console.log(`  Birth: Dogy #${ev.args.dogyId} from Pup #${ev.args.pupId}, edition ${ev.args.edition}, gas ${rcpt.gasUsed}`);
    const cost = await dogy.nextRerollCost(ev.args.dogyId, 1);
    await (await mug.approve(dogy, cost)).wait();
    await (await dogy.reroll(ev.args.dogyId, 1)).wait();
    console.log(`  Rerolled Power for ${ethers.formatUnits(cost, 18)} MUG`);
    await (await dogy.lock(ev.args.dogyId, "Fuji Dogy")).wait();
    const b = await dogy.births(ev.args.dogyId);
    console.log(`  Locked as "${b.name}", sacrifice ${ethers.formatUnits(b.sacrifice, 18)} MUG, tokenURI ${await dogy.tokenURI(ev.args.dogyId)}`);
  }

  if (!dryRun) {
    const file = path.join(__dirname, "..", "deployments", "fuji.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    console.log(`\nwrote ${file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
