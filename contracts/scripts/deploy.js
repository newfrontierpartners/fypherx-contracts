const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const networkName = hre.network.name;

  const initialRelayer = process.env.INITIAL_RELAYER || deployer.address;
  const initialOperator = process.env.INITIAL_OPERATOR || deployer.address;

  const settlementFactory = await hre.ethers.getContractFactory("FypherXSettlement");
  const settlement = await settlementFactory.deploy(initialRelayer);
  await settlement.waitForDeployment();

  const vaultFactory = await hre.ethers.getContractFactory("FypherXInsuranceFundVault");
  const vault = await vaultFactory.deploy(initialOperator);
  await vault.waitForDeployment();

  let oracles = null;
  const shouldDeployMockOracles =
    networkName === "localhost" || String(process.env.DEPLOY_MOCK_ORACLES || "").toLowerCase() === "true";

  if (shouldDeployMockOracles) {
    const oracleFactory = await hre.ethers.getContractFactory("MockPriceOracle");
    const btcIndex = await oracleFactory.deploy(8, "6000000000000");
    await btcIndex.waitForDeployment();
    const btcMark = await oracleFactory.deploy(8, "6002500000000");
    await btcMark.waitForDeployment();
    const ethIndex = await oracleFactory.deploy(8, "300000000000");
    await ethIndex.waitForDeployment();
    const ethMark = await oracleFactory.deploy(8, "300150000000");
    await ethMark.waitForDeployment();

    oracles = {
      "BTC-PERP": {
        indexFeedAddress: await btcIndex.getAddress(),
        markFeedAddress: await btcMark.getAddress()
      },
      "ETH-PERP": {
        indexFeedAddress: await ethIndex.getAddress(),
        markFeedAddress: await ethMark.getAddress()
      }
    };
  }

  const deployment = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    initialRelayer,
    initialOperator,
    settlementAddress: await settlement.getAddress(),
    insuranceFundVaultAddress: await vault.getAddress(),
    oracles,
    deployedAt: new Date().toISOString()
  };

  const outputDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${networkName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

  console.log(JSON.stringify(deployment, null, 2));
  console.log(`Deployment file written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
