/**
 * Ad-hoc probe: reads the FypherMinting proxy's current state to diagnose
 * why mint() txs are reverting at ~48k gas. The revert pattern + exactly
 * one ecrecover precompile call in the internal tx list points at
 * `InvalidSignature` in `_verifyOrder` — i.e. the backend is signing with
 * a key that no longer matches `backendSigner`.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const addrs = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  );
  const minting = new ethers.Contract(addrs.FypherMinting, [
    "function backendSigner() view returns (address)",
    "function backendExecutor() view returns (address)",
    "function rusd() view returns (address)",
    "function mintRedeemDisabled() view returns (bool)",
    "function globalMaxMintPerBlock() view returns (uint256)",
    "function supportedAssets(address) view returns (bool)",
  ], ethers.provider);

  console.log("FypherMinting proxy:", addrs.FypherMinting);
  console.log("backendSigner     :", await minting.backendSigner());
  console.log("backendExecutor   :", await minting.backendExecutor());
  console.log("rusd              :", await minting.rusd());
  console.log("mintRedeemDisabled:", await minting.mintRedeemDisabled());
  console.log("globalMaxMint/block:", (await minting.globalMaxMintPerBlock()).toString());
  for (const sym of ["USDT", "USDC", "WETH"]) {
    const addr = addrs[sym];
    if (!addr) continue;
    const ok = await minting.supportedAssets(addr);
    console.log(`supportedAssets[${sym.padEnd(5)}] (${addr}): ${ok}`);
  }

  // Also check the tx sender's balance in case front-end pre-check is wrong.
  const USER = "0x3C886D7C56Ca228FB575aAaa4890C5dbB716eC99";
  const native = await ethers.provider.getBalance(USER);
  console.log(`\nuser ${USER} native: ${ethers.formatEther(native)}`);
  for (const sym of ["USDT", "USDC"]) {
    const token = new ethers.Contract(addrs[sym], [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ], ethers.provider);
    const bal = await token.balanceOf(USER);
    const alw = await token.allowance(USER, addrs.FypherMinting);
    const dec = await token.decimals();
    console.log(`${sym} (dec=${dec})  bal=${ethers.formatUnits(bal, dec)}  allowance→Minting=${ethers.formatUnits(alw, dec)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
