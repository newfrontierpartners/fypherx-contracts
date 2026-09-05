/**
 * Deploy MockERC20 WETH on HOODI testnet (chainId 560048).
 *
 * Standalone, narrow script — does NOT touch the rest of the stack.
 * USDT/USDC are already deployed on HOODI; WETH was the only mock left
 * blank in addresses/560048.json.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-weth-hoodi.js --network hoodi
 */
const { ethers } = require("hardhat");

const EXPECTED_CHAIN_ID = 560048;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(
      `\nERROR: deploy-weth-hoodi.js requires chainId ${EXPECTED_CHAIN_ID}, ` +
      `got ${chainId}. Re-run with --network hoodi.\n`
    );
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`[weth-deploy] deployer ${deployer.address}`);
  console.log(`[weth-deploy] balance  ${ethers.formatEther(bal)} ETH\n`);

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  console.log("[weth-deploy] deploying MockERC20(WETH, WETH, 18) ...");
  const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
  await weth.waitForDeployment();
  const wethAddr = await weth.getAddress();
  console.log(`           ↳ ${wethAddr}`);

  const amt = ethers.parseUnits("10000", 18);
  console.log(`\n[weth-deploy] minting 10,000 WETH to deployer ...`);
  await (await weth.mint(deployer.address, amt)).wait();
  const balAfter = await weth.balanceOf(deployer.address);
  console.log(`           ↳ balance ${ethers.formatUnits(balAfter, 18)} WETH`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  WETH deployed: ${wethAddr}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("\nNext steps (manual):");
  console.log(`  1. Update addresses/560048.json   → "WETH": "${wethAddr}"`);
  console.log(`  2. Update frontend addresses.ts   → HOODI_CONTRACTS.WETH`);
  console.log(`     (currently '0x0000…0000' placeholder)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
