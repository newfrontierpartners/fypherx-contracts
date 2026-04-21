const { ethers } = require("hardhat");
const PAIR = "0x8Db6D9529344b55156B2f602a550f71A07320087";

async function main() {
  const abi = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function getReserves() view returns (uint112,uint112,uint32)",
    "function totalSupply() view returns (uint256)",
  ];
  const p = new ethers.Contract(PAIR, abi, ethers.provider);
  const [t0, t1, r, supply] = await Promise.all([p.token0(), p.token1(), p.getReserves(), p.totalSupply()]);
  console.log("token0         =", t0);
  console.log("token1         =", t1);
  console.log("reserve0       =", r[0].toString());
  console.log("reserve1       =", r[1].toString());
  console.log("totalSupply(LP)=", supply.toString());
}
main().catch(e => { console.error(e); process.exit(1); });
