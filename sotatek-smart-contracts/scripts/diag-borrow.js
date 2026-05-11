const { ethers } = require("hardhat");

async function main() {
  const market = "0x529F1407d97672795361EB7E3A698C5c1C3F0bEd";
  const user   = "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4";
  const usdt   = "0x5a0bc2C2c0b9e8b0c0e1e1e1e1e1e1e1e1e1f75b"; // placeholder, will read from market
  const abi = [
    "function loanToken() view returns (address)",
    "function collateralToken() view returns (address)",
    "function totalSupplyAssets() view returns (uint256)",
    "function totalBorrowAssets() view returns (uint256)",
    "function supplyCap() view returns (uint256)",
    "function borrowCap() view returns (uint256)",
    "function lltvBps() view returns (uint256)",
    "function supplyAssetsOf(address) view returns (uint256)",
    "function borrowSharesOf(address) view returns (uint256)",
    "function collateralOf(address) view returns (uint256)",
    "function debtAssetsOf(address) view returns (uint256)",
    "function healthFactor(address) view returns (uint256)",
  ];
  const m = await ethers.getContractAt(abi, market);
  const erc20 = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];

  const loan = await m.loanToken();
  const collat = await m.collateralToken();
  console.log("loanToken      :", loan);
  console.log("collateralToken:", collat);

  const totSup = await m.totalSupplyAssets();
  const totBor = await m.totalBorrowAssets();
  const supCap = await m.supplyCap();
  const borCap = await m.borrowCap();
  const lltv   = await m.lltvBps();
  console.log("totalSupplyAssets:", ethers.formatUnits(totSup, 18));
  console.log("totalBorrowAssets:", ethers.formatUnits(totBor, 18));
  console.log("supplyCap        :", ethers.formatUnits(supCap, 18));
  console.log("borrowCap        :", ethers.formatUnits(borCap, 18));
  console.log("lltv (bps/1e4)   :", lltv.toString());

  const userSup = await m.supplyAssetsOf(user);
  const userCol = await m.collateralOf(user);
  let userDebt = 0n;
  try { userDebt = await m.debtAssetsOf(user); } catch (e) { userDebt = -1n; }
  console.log("\nUser state:");
  console.log("  supplyAssetsOf:", ethers.formatUnits(userSup, 18));
  console.log("  collateralOf  :", ethers.formatUnits(userCol, 18));
  console.log("  debtOf        :", userDebt === -1n ? "REVERT" : ethers.formatUnits(userDebt, 18));

  // Loan token balance in market
  const loanC = await ethers.getContractAt(erc20, loan);
  const symL = await loanC.symbol();
  const balLoanInMarket = await loanC.balanceOf(market);
  const balLoanUser = await loanC.balanceOf(user);
  console.log(`\n${symL} (loan token) balance in market:`, ethers.formatUnits(balLoanInMarket, 18));
  console.log(`${symL} balance of user:`, ethers.formatUnits(balLoanUser, 18));

  const collC = await ethers.getContractAt(erc20, collat);
  const symC = await collC.symbol();
  const balCollUser = await collC.balanceOf(user);
  console.log(`${symC} (collat token) balance of user:`, ethers.formatUnits(balCollUser, 18));

  // Try staticCall to borrow
  console.log("\nSimulating borrow(870e18, user) staticCall:");
  const mWrite = await ethers.getContractAt(["function borrow(uint256,address) returns (uint256)"], market);
  try {
    const out = await mWrite.borrow.staticCall(ethers.parseUnits("870", 18), user);
    console.log("  would succeed, shares:", out.toString());
  } catch (e) {
    console.log("  REVERT:", e.shortMessage || e.message.slice(0, 200));
    if (e.data) console.log("  data:", e.data);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
