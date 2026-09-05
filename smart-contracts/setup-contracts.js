const { ethers } = require("ethers");
const ADDRESSES = require("./deployed-addresses.json");

const RPC = "https://data-seed-prebsc-1-s1.binance.org:8545";
// This key derives to 0x31B60b11533c97b5ED7b1B650D31855F3754Acb4
// which is the contract owner & backendSigner for the deployed contracts.
const PRIVATE_KEY = "0x92103c1eac100bc3d718c8948c0edfa432c0fab48f9694a97139737d6e926e82";

const MINTING_ABI = [
  "function addSupportedAsset(address asset) external",
  "function removeSupportedAsset(address asset) external",
  "function setBackendSigner(address signer) external",
  "function setBackendExecutor(address executor) external",
  "function disableMintRedeem(bool disable) external",
  "function mintRedeemDisabled() view returns (bool)",
  "function supportedAssets(address) view returns (bool)",
  "function backendSigner() view returns (address)",
  "function backendExecutor() view returns (address)",
  "function addCustodianAddress(address custodian) external",
  "function custodianAddresses(address) view returns (bool)",
];

const ERC20_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Deployer:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("BNB balance:", ethers.formatEther(balance));

  if (balance === 0n) {
    console.log("ERROR: No BNB for gas! Get testnet BNB from faucet.");
    return;
  }

  const minting = new ethers.Contract(ADDRESSES.FypherMinting, MINTING_ABI, wallet);

  // 1. Check current state
  console.log("\n=== Current State ===");
  const disabled = await minting.mintRedeemDisabled();
  console.log("mintRedeemDisabled:", disabled);
  const usdcSupported = await minting.supportedAssets(ADDRESSES.USDC);
  console.log("USDC supported:", usdcSupported);
  const usdtSupported = await minting.supportedAssets(ADDRESSES.USDT);
  console.log("USDT supported:", usdtSupported);

  let signer, executor;
  try { signer = await minting.backendSigner(); console.log("backendSigner:", signer); } catch(e) { console.log("backendSigner: error -", e.message?.slice(0,80)); }
  try { executor = await minting.backendExecutor(); console.log("backendExecutor:", executor); } catch(e) { console.log("backendExecutor: error -", e.message?.slice(0,80)); }

  // 2. Enable mint/redeem if disabled
  if (disabled) {
    console.log("\n=== Enabling Mint/Redeem ===");
    const tx = await minting.disableMintRedeem(false);
    await tx.wait();
    console.log("✓ Mint/Redeem enabled");
  }

  // 3. Add supported assets
  for (const name of ["USDC", "USDT", "WETH", "BTC", "BNB"]) {
    const addr = ADDRESSES[name];
    if (!addr) continue;
    const supported = await minting.supportedAssets(addr);
    if (!supported) {
      console.log(`=== Adding ${name} as supported asset ===`);
      const tx = await minting.addSupportedAsset(addr);
      await tx.wait();
      console.log(`✓ ${name} added`);
    }
  }

  // 4. Set backend signer & executor = deployer wallet
  console.log("\n=== Setting backend signer & executor ===");
  if (signer?.toLowerCase() !== wallet.address.toLowerCase()) {
    const tx1 = await minting.setBackendSigner(wallet.address);
    await tx1.wait();
    console.log("✓ Backend signer set to:", wallet.address);
  } else {
    console.log("✓ Backend signer already correct:", signer);
  }

  if (executor?.toLowerCase() !== wallet.address.toLowerCase()) {
    const tx2 = await minting.setBackendExecutor(wallet.address);
    await tx2.wait();
    console.log("✓ Backend executor set to:", wallet.address);
  } else {
    console.log("✓ Backend executor already correct:", executor);
  }

  // 5. Add ReservePool as custodian
  const isCustodian = await minting.custodianAddresses(ADDRESSES.ReservePool);
  if (!isCustodian) {
    console.log("\n=== Adding ReservePool as custodian ===");
    const tx = await minting.addCustodianAddress(ADDRESSES.ReservePool);
    await tx.wait();
    console.log("✓ ReservePool added as custodian");
  }

  // 6. Mint test tokens to deployer wallet
  console.log("\n=== Minting test tokens ===");
  const amount = ethers.parseUnits("10000", 18);

  for (const name of ["USDC", "USDT"]) {
    const token = new ethers.Contract(ADDRESSES[name], ERC20_ABI, wallet);
    const bal = await token.balanceOf(wallet.address);
    console.log(`${name} balance: ${ethers.formatUnits(bal, 18)}`);
    if (bal < amount) {
      const tx = await token.mint(wallet.address, amount);
      await tx.wait();
      const newBal = await token.balanceOf(wallet.address);
      console.log(`✓ Minted ${name}, new balance: ${ethers.formatUnits(newBal, 18)}`);
    }
  }

  // 7. Final state
  console.log("\n=== Final State ===");
  console.log("mintRedeemDisabled:", await minting.mintRedeemDisabled());
  console.log("USDC supported:", await minting.supportedAssets(ADDRESSES.USDC));
  console.log("USDT supported:", await minting.supportedAssets(ADDRESSES.USDT));

  const rusd = new ethers.Contract(ADDRESSES.RUSD, ERC20_ABI, wallet);
  console.log("RUSD totalSupply:", ethers.formatUnits(await rusd.totalSupply(), 18));
  console.log("RUSD balance (deployer):", ethers.formatUnits(await rusd.balanceOf(wallet.address), 18));

  console.log("\n✅ Setup complete!");
}

main().catch(console.error);
