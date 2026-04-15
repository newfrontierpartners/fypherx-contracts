const { ethers } = require("hardhat");
const ADDRESSES = require("../deployed-addresses.json");

async function main() {
  const [deployer] = await ethers.getSigners();
  const to = "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4";
  const amount = ethers.parseUnits("10000", 18);

  const tokens = [
    { name: "USDT",  address: ADDRESSES.USDT },
    { name: "USDC",  address: ADDRESSES.USDC },
    { name: "WETH",  address: ADDRESSES.WETH },
    { name: "BTC",   address: ADDRESSES.BTC },
    { name: "BNB",   address: ADDRESSES.BNB },
    { name: "RUSD",  address: ADDRESSES.RUSD },
    { name: "FYP",   address: ADDRESSES.FYP },
    { name: "iRUSD", address: ADDRESSES.iRUSD },
  ];

  console.log(`Minting tokens to ${to}...`);
  console.log(`Deployer: ${deployer.address}\n`);

  for (const token of tokens) {
    try {
      const contract = await ethers.getContractAt(
        ["function mint(address to, uint256 amount) external", "function balanceOf(address) view returns (uint256)"],
        token.address
      );

      const tx = await contract.mint(to, amount);
      await tx.wait();

      const balance = await contract.balanceOf(to);
      console.log(`${token.name}: Minted 10,000 -> Balance: ${ethers.formatUnits(balance, 18)}`);
    } catch (e) {
      console.log(`${token.name}: FAILED - ${e.message.slice(0, 80)}`);
    }
  }

  console.log("\nDone!");
}

main().catch(console.error);
