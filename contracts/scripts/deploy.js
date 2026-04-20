// FypherX perps contract deployment script.
//
// Deploys the 4-contract perps stack against the target network:
//   1. FypherOracleRouter         — on-chain mark-price aggregator
//   2. FypherXSettlement          — immutable trade-settlement events (EIP-712)
//   3. FypherXInsuranceFundVault  — ERC-20 backed bad-debt buffer
//   4. FypherPerpsClearinghouse   — collateral vault + position ledger
//
// For BSC Testnet the collateral token is the pre-deployed RUSD at
// 0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5 (see sotatek deployed-addresses
// in fypherx-contracts/sotatek-smart-contracts/deployed-addresses.json).
// Override with COLLATERAL_TOKEN_ADDRESS for other networks.
//
// Env vars:
//   DEPLOYER_PRIVATE_KEY   required — signing key for all tx
//   INITIAL_RELAYER        optional — defaults to deployer; the relayer
//                          backend must post settleTrade / executeMatchedTrade
//                          calls from this key.
//   INITIAL_SIGNER         optional — defaults to deployer; a SEPARATE key
//                          (ideally KMS-held) whose EIP-712 signature
//                          authorises each settleTrade. Using the relayer key
//                          here is fine on testnet but defeats the audit H-5
//                          two-key-split guarantee on mainnet.
//   INITIAL_OPERATOR       optional — defaults to deployer; authorised to
//                          pull from the insurance vault.
//   COLLATERAL_TOKEN_ADDRESS optional — defaults to BSC Testnet RUSD.
//   DEPLOY_MOCK_ORACLES    optional — "true" to also deploy MockPriceOracle
//                          instances and auto-configure BTC/ETH markets.
//   AUTO_CONFIGURE_MARKETS optional — "true" to call configureMarket on the
//                          clearinghouse for BTC/ETH with sensible defaults.
//
// Output is written to ./deployments/<network>.json and printed to stdout.
// Copy the addresses into the backend env vars — see
// docs/DEX_PERPS_PROVISIONING.md.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

// Sensible defaults for a first deployment. The operator can reconfigure via
// configureMarket() afterwards without redeploying.
const DEFAULT_MARKET_CONFIG = {
  initialMarginBps: 1000,          // 10% IM → max 10x leverage via IM
  maintenanceMarginBps: 500,       // 5% MM
  maxTradeDeviationBps: 500,       // 5% of oracle price
  maxLeverageE18: 10n * 10n ** 18n,
  maxPositionSizeE18: 1_000_000n * 10n ** 18n
};

const BSC_TESTNET_RUSD = "0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5";

function marketIdBytes32(symbol) {
  // Matches the backend's `Hash.sha3String(marketId)` so the same market key
  // is used off-chain and on-chain. Keep this in sync with the Java side in
  // RpcEvmSettlementAdapter / RpcClearinghouseChainClient.
  return hre.ethers.keccak256(hre.ethers.toUtf8Bytes(symbol));
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const networkName = hre.network.name;

  const initialRelayer = process.env.INITIAL_RELAYER || deployer.address;
  const initialSigner = process.env.INITIAL_SIGNER || deployer.address;
  const initialOperator = process.env.INITIAL_OPERATOR || deployer.address;

  // Collateral token — BSC Testnet defaults to the pre-deployed RUSD but
  // allow override for other environments.
  const collateralToken = process.env.COLLATERAL_TOKEN_ADDRESS
    || (networkName === "bscTestnet" ? BSC_TESTNET_RUSD : null);
  if (!collateralToken) {
    throw new Error(
      "COLLATERAL_TOKEN_ADDRESS must be set (no default for network=" + networkName + ")"
    );
  }

  console.log(`[deploy] network=${networkName} chainId=${network.chainId} deployer=${deployer.address}`);
  console.log(`[deploy] relayer=${initialRelayer} signer=${initialSigner} operator=${initialOperator}`);
  console.log(`[deploy] collateralToken=${collateralToken}`);

  // ── 1. Oracle Router ──────────────────────────────────────────────────
  const oracleFactory = await hre.ethers.getContractFactory("FypherOracleRouter");
  const oracleRouter = await oracleFactory.deploy();
  await oracleRouter.waitForDeployment();
  const oracleRouterAddress = await oracleRouter.getAddress();
  console.log(`[deploy] FypherOracleRouter → ${oracleRouterAddress}`);

  // ── 2. Settlement (events-only, EIP-712) ──────────────────────────────
  const settlementFactory = await hre.ethers.getContractFactory("FypherXSettlement");
  const settlement = await settlementFactory.deploy(initialRelayer, initialSigner);
  await settlement.waitForDeployment();
  const settlementAddress = await settlement.getAddress();
  console.log(`[deploy] FypherXSettlement → ${settlementAddress}`);

  // ── 3. Insurance Fund Vault (ERC-20) ──────────────────────────────────
  const vaultFactory = await hre.ethers.getContractFactory("FypherXInsuranceFundVault");
  const vault = await vaultFactory.deploy(collateralToken, initialOperator);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`[deploy] FypherXInsuranceFundVault → ${vaultAddress}`);

  // ── 4. Perps Clearinghouse ────────────────────────────────────────────
  const clearinghouseFactory = await hre.ethers.getContractFactory("FypherPerpsClearinghouse");
  const clearinghouse = await clearinghouseFactory.deploy(collateralToken, oracleRouterAddress);
  await clearinghouse.waitForDeployment();
  const clearinghouseAddress = await clearinghouse.getAddress();
  console.log(`[deploy] FypherPerpsClearinghouse → ${clearinghouseAddress}`);

  // Wire roles: relayer (backend) authorised on clearinghouse, clearinghouse
  // authorised on insurance fund so liquidate() can pull deficits.
  console.log("[deploy] Authorising relayer on clearinghouse…");
  await (await clearinghouse.setRelayer(initialRelayer, true)).wait();
  console.log("[deploy] Authorising clearinghouse as operator on insurance fund…");
  await (await vault.setOperator(clearinghouseAddress, true)).wait();
  console.log("[deploy] Linking insurance fund to clearinghouse…");
  await (await clearinghouse.setInsuranceFund(vaultAddress)).wait();

  // ── Optional: mock oracles + market auto-configure ────────────────────
  let oracles = null;
  const shouldDeployMockOracles =
    networkName === "localhost"
      || String(process.env.DEPLOY_MOCK_ORACLES || "").toLowerCase() === "true";

  if (shouldDeployMockOracles) {
    console.log("[deploy] Deploying mock price oracles…");
    const mockFactory = await hre.ethers.getContractFactory("MockPriceOracle");
    const btcFeed = await mockFactory.deploy(8, "6000000000000");      // $60,000 at 8 decimals
    await btcFeed.waitForDeployment();
    const ethFeed = await mockFactory.deploy(8, "300000000000");       // $3,000 at 8 decimals
    await ethFeed.waitForDeployment();
    const btcFeedAddr = await btcFeed.getAddress();
    const ethFeedAddr = await ethFeed.getAddress();

    console.log("[deploy] Registering mock feeds on oracle router…");
    await (await oracleRouter.configureMarketOracle(
      marketIdBytes32("BTC-PERP"), btcFeedAddr, 8, 3600, true
    )).wait();
    await (await oracleRouter.configureMarketOracle(
      marketIdBytes32("ETH-PERP"), ethFeedAddr, 8, 3600, true
    )).wait();

    oracles = {
      "BTC-PERP": { feed: btcFeedAddr, decimals: 8 },
      "ETH-PERP": { feed: ethFeedAddr, decimals: 8 }
    };
  }

  const shouldConfigureMarkets =
    shouldDeployMockOracles
      || String(process.env.AUTO_CONFIGURE_MARKETS || "").toLowerCase() === "true";

  if (shouldConfigureMarkets) {
    console.log("[deploy] Configuring BTC-PERP / ETH-PERP on clearinghouse…");
    for (const symbol of ["BTC-PERP", "ETH-PERP"]) {
      await (await clearinghouse.configureMarket(
        marketIdBytes32(symbol),
        DEFAULT_MARKET_CONFIG.initialMarginBps,
        DEFAULT_MARKET_CONFIG.maintenanceMarginBps,
        DEFAULT_MARKET_CONFIG.maxTradeDeviationBps,
        DEFAULT_MARKET_CONFIG.maxLeverageE18,
        DEFAULT_MARKET_CONFIG.maxPositionSizeE18,
        true
      )).wait();
    }
  }

  const deployment = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    initialRelayer,
    initialSigner,
    initialOperator,
    collateralToken,
    oracleRouterAddress,
    settlementAddress,
    insuranceFundVaultAddress: vaultAddress,
    clearinghouseAddress,
    oracles,
    marketsConfigured: shouldConfigureMarkets ? ["BTC-PERP", "ETH-PERP"] : [],
    deployedAt: new Date().toISOString()
  };

  const outputDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${networkName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

  console.log("\n==== DEPLOYMENT SUMMARY ====");
  console.log(JSON.stringify(deployment, null, 2));
  console.log(`\nSaved to ${outputPath}`);
  console.log("\nNext: copy addresses into backend env vars — see docs/DEX_PERPS_PROVISIONING.md");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
