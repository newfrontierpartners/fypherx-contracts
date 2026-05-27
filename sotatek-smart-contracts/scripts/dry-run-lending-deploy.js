/**
 * In-memory dry run of the lending stack deploy. Validates:
 *   • All contracts compile + construct with the params we hard-coded.
 *   • InsuranceFund.setFactory + factory.createMarket whitelist flow works.
 *   • OracleRouter.setAdapter wires the (collat, loan) pair.
 *
 * Run: `npx hardhat run scripts/dry-run-lending-deploy.js`
 *
 * NOTE: This is a one-off verification helper, NOT a Sepolia entrypoint.
 *       Stage 1 sepolia entrypoint = scripts/deploy-lending-sepolia.js.
 */
const { ethers } = require("hardhat");

const WAD = 10n ** 18n;

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`[dry-run] chainId=${net.chainId} deployer=${deployer.address}`);

  // Mock RUSD + USDT (18 dec).
  const Mock = await ethers.getContractFactory("MockERC20");
  const rusd = await Mock.deploy("Mock RUSD", "RUSD", 18);
  const usdt = await Mock.deploy("Mock USDT", "USDT", 18);
  await rusd.waitForDeployment();
  await usdt.waitForDeployment();

  const KinkedIRM = await ethers.getContractFactory("KinkedIRM");
  const irm = await KinkedIRM.deploy(
    (WAD * 4n) / 100n,
    (WAD * 80n) / 100n,
    (WAD * 10n) / 100n,
    (WAD * 250n) / 100n
  );
  await irm.waitForDeployment();

  const InsuranceFundV2 = await ethers.getContractFactory("InsuranceFundV2");
  const fund = await InsuranceFundV2.deploy(deployer.address);
  await fund.waitForDeployment();

  const OracleRouterV2 = await ethers.getContractFactory("OracleRouterV2");
  const router = await OracleRouterV2.deploy(deployer.address);
  await router.waitForDeployment();

  const Factory = await ethers.getContractFactory("FypherLendingMarketFactory");
  const factory = await Factory.deploy(deployer.address, await fund.getAddress());
  await factory.waitForDeployment();

  await (await fund.setFactory(await factory.getAddress())).wait();

  const Const = await ethers.getContractFactory("ConstantOracleAdapter");
  const oracle = await Const.deploy(10n ** 36n);
  await oracle.waitForDeployment();

  await (await router.setAdapter(
    await rusd.getAddress(),
    await usdt.getAddress(),
    await oracle.getAddress()
  )).wait();

  const initParams = {
    loanToken:           await usdt.getAddress(),
    collateralToken:     await rusd.getAddress(),
    oracle:              await oracle.getAddress(),
    irm:                 await irm.getAddress(),
    lltvBps:             9200n,
    liquidationBonusBps: 500n,
    reserveFactorBps:    1000n,
    supplyCap:           0n,
    borrowCap:           0n,
    timelock:            deployer.address,
    insuranceFund:       await fund.getAddress(),
  };

  const tx = await factory.createMarket(initParams);
  const rcpt = await tx.wait();
  const topic = factory.interface.getEvent("MarketCreated").topicHash;
  const log = rcpt.logs.find(l => l.topics[0] === topic);
  const marketAddr = factory.interface.parseLog(log).args.market;

  // Verify market is whitelisted on the insurance fund.
  const allowed = await fund.allowedMarket(marketAddr);
  if (!allowed) throw new Error("market not whitelisted on insurance fund");

  // Verify market state via direct view calls.
  const market = await ethers.getContractAt("FypherLendingMarket", marketAddr);
  const lltv = await market.lltvBps();
  const oracleSet = await market.oracle();
  if (Number(lltv) !== 9200) throw new Error(`lltvBps mismatch: ${lltv}`);
  if (oracleSet.toLowerCase() !== (await oracle.getAddress()).toLowerCase()) {
    throw new Error("oracle mismatch");
  }

  console.log(`[dry-run] OK — market=${marketAddr}, lltvBps=${lltv}, whitelisted=${allowed}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
