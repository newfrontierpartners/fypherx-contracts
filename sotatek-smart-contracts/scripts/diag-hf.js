const { ethers } = require("hardhat");
async function main() {
  const user = "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4";
  const markets = [
    ["RUSD/USDT",   "0x78B32dCCbAf566a5843615297a232b71347a9318"],
    ["sRUSD/USDT",  "0x70c094934aFbB9b24D675249C88F74e5A5b07198"],
    ["sFYUSD/USDC", "0xb1eCc212114b69A4A489546E4b97e966249DceC6"],
    ["USDC/USDT",   "0x529F1407d97672795361EB7E3A698C5c1C3F0bEd"],
    ["FYUSD/USDT",  "0x8c980aFeE88ba72D91dB447896C523e51fA44Ba6"],
  ];
  const abi = [
    "function healthFactor(address) view returns (uint256)",
    "function supplySharesOf(address) view returns (uint256)",
    "function borrowSharesOf(address) view returns (uint256)",
    "function collateralOf(address) view returns (uint256)",
    "function supplyAssetsOf(address) view returns (uint256)",
    "function debtAssetsOf(address) view returns (uint256)",
  ];
  for (const [name, addr] of markets) {
    const m = await ethers.getContractAt(abi, addr);
    const calls = [
      ["supplyShares", () => m.supplySharesOf(user)],
      ["borrowShares", () => m.borrowSharesOf(user)],
      ["collateral",   () => m.collateralOf(user)],
      ["supplyAssets", () => m.supplyAssetsOf(user)],
      ["debtAssets",   () => m.debtAssetsOf(user)],
      ["healthFactor", () => m.healthFactor(user)],
    ];
    process.stdout.write(`\n${name} ${addr}:\n`);
    for (const [n, fn] of calls) {
      try { const v = await fn(); process.stdout.write(`  ${n}: ${v.toString()}\n`); }
      catch (e) { process.stdout.write(`  ${n}: REVERT (${e.shortMessage || (e.message||'').slice(0,80)})\n`); }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
