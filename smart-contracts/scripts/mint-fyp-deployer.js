// Mint 100k FYP to deployer for bootstrap-fpy-treasury.
const { ethers } = require("hardhat");
const addresses = require("./lib/addresses");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const addrs = addresses.load(chainId);
  const fyp = await ethers.getContractAt("FYP", addrs.FYP);
  const amount = 100_000n * 10n ** 18n;
  console.log(`Minting 100,000 FYP to ${deployer.address}...`);
  const tx = await fyp.mint(deployer.address, amount);
  await tx.wait();
  const bal = await fyp.balanceOf(deployer.address);
  console.log(`✓ minted (tx: ${tx.hash}). Balance: ${ethers.formatUnits(bal, 18)} FYP`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
