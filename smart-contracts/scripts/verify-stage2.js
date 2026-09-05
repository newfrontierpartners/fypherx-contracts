const { ethers } = require("hardhat");
async function main() {
  const f = await ethers.getContractAt("FypherLendingMarketFactory", "0xb260b1f9eD00dd0a40fF1dDfAC333184db88d119");
  const n = await f.marketCount();
  console.log("marketCount =", n.toString());
  for (let i = 0; i < Number(n); i++) console.log(`  [${i}]`, await f.markets(i));
}
main().catch(e => { console.error(e); process.exit(1); });
