/**
 * Ad-hoc probe: for RUSD paired against each of {USDT, USDC, FYUSD, FYP},
 * ask the Pancake V2 factory whether a pair exists. Used to diagnose the
 * create-then-immediately-query race that surfaced on BSC testnet.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const addrs = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  );
  const factoryAbi = ["function getPair(address,address) view returns (address)"];
  const factory = new ethers.Contract(addrs.PancakeV2Factory, factoryAbi, ethers.provider);
  const rusd = addrs.RUSD;
  for (const sym of ["USDT", "USDC", "FYUSD", "FYP"]) {
    const p = await factory.getPair(rusd, addrs[sym]);
    console.log(`RUSD/${sym.padEnd(5)} -> ${p}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
