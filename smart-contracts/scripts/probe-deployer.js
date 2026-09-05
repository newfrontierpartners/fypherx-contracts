/**
 * Pre-flight — confirms the .env PRIVATE_KEY resolves to an address with
 * enough tBNB to cover the 9-step deploy + governance hand-off txs.
 *
 * Expected address (matches deployed backendSigner per user note): 0x31B60b11...acb4
 */
const { ethers } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners();
  const addr = signer.address;
  const bal = await ethers.provider.getBalance(addr);
  const balEth = ethers.formatEther(bal);
  const net = await ethers.provider.getNetwork();

  console.log("chainId :", net.chainId.toString());
  console.log("signer  :", addr);
  console.log("balance :", balEth, "BNB");

  // Budget estimate: 9 deploys + ~8 state-changing calls ≈ 17 tx × 2M gas × 3 gwei ≈ 0.1 BNB headroom.
  const min = ethers.parseEther("0.1");
  console.log(bal >= min ? "OK: >= 0.1 tBNB budget" : "LOW: top up before deploy");
}

main().catch((e) => { console.error(e); process.exit(1); });
