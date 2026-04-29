/**
 * Pre-deploy probe — checks that the BSC Testnet PancakeSwap V2 router we're
 * baking into `deploy-lp-lending.js` actually has code, and reports whether
 * the RUSD/USDT pair already exists via its factory. If the pair is the
 * zero address we need an extra factory.createPair() step before LPVault.
 */
const { ethers } = require("hardhat");

const CANDIDATE_ROUTERS = [
  "0xD99D1c33F9fC3444f8101754aBC46c52416550D1", // PCS V2 testnet (legacy)
  "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3", // alt
];
const RUSD = "0xF3ac96da1edD17bb0e803Ad1d1c9Cbc18b42FaB5";
const USDT = "0x786d227a88f67E416784623EdF3603e65F0eaA99";

async function main() {
  const routerAbi = ["function factory() view returns (address)"];
  const factoryAbi = ["function getPair(address,address) view returns (address)"];
  for (const addr of CANDIDATE_ROUTERS) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") { console.log(`${addr}  NO_CODE`); continue; }
    const r = new ethers.Contract(addr, routerAbi, ethers.provider);
    const factory = await r.factory();
    const f = new ethers.Contract(factory, factoryAbi, ethers.provider);
    const pair = await f.getPair(RUSD, USDT);
    console.log(`router  = ${addr}`);
    console.log(`factory = ${factory}`);
    console.log(`pair    = ${pair}  (${pair === ethers.ZeroAddress ? "NEEDS_CREATE" : "EXISTS"})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
