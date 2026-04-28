/**
 * One-shot diagnostic: decode the failing mint() calldata from tx
 * 0xb0772...5dd0 on BSC Testnet, re-compute the expected signing hash
 * using the contract's `hashOrder` + EIP-191 prefix, recover the
 * signer, and compare against the on-chain `backendSigner`.
 *
 * If recovered != backendSigner, the revert is `InvalidSignature` and
 * the fix is on the backend (rotate BACKEND_SIGNER_PRIVATE_KEY).
 */
const { ethers } = require("hardhat");

// Copied verbatim from the bscscan raw-tx dump for this failing tx.
const CALLDATA = "0x7f5f99fb0000000000000000000000003c886d7c56ca228fb575aaaa4890c5dbb716ec990000000000000000000000003c886d7c56ca228fb575aaaa4890c5dbb716ec99000000000000000000000000786d227a88f67e416784623edf3603e65f0eaa990000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000000000000069e79cc40000000000000000000000000000000000000000000000000000000069ea3da0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000010000000000000000000000009ddac07079537159765a6e083b1bb3a2fcfb84bb000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000041dcb8b9a14828bb75a01fbea1717c94ca4910dc54524c8d5446739cc5eeb52e2353e4df07cd74ef359c7c21f43fd02a0185591c8ba491c13c0fb19c8944373d4a1c00000000000000000000000000000000000000000000000000000000000000";

const ON_CHAIN_BACKEND_SIGNER = "0x31B60b11533c97b5ED7b1B650D31855F3754Acb4";

// Default private key baked into fypherx-gateway application.yml — the
// Hardhat/Anvil test account #0. If backend runs without a k8s override,
// this is what signs orders.
const HARDHAT_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_KEY0_ADDR = new ethers.Wallet(HARDHAT_KEY0).address;

async function main() {
  // ── 1. Decode calldata ──
  // Function: mint((address,address,address,uint256,uint256,uint256,uint256),(address[],uint256[]),bytes)
  const iface = new ethers.Interface([
    "function mint(tuple(address benefactor, address beneficiary, address collateral_asset, uint256 collateral_amount, uint256 rusd_amount, uint256 nonce, uint256 expiry) order, tuple(address[] addresses, uint256[] ratios) route, bytes signature)"
  ]);
  const parsed = iface.parseTransaction({ data: CALLDATA });
  console.log("selector     :", parsed.signature);
  const [order, route, signature] = parsed.args;
  console.log("order.benefactor     :", order.benefactor);
  console.log("order.beneficiary    :", order.beneficiary);
  console.log("order.collateral     :", order.collateral_asset);
  console.log("order.collAmount     :", order.collateral_amount.toString(), `(${ethers.formatUnits(order.collateral_amount, 18)} @ 18dp)`);
  console.log("order.rusdAmount     :", order.rusd_amount.toString(),       `(${ethers.formatUnits(order.rusd_amount, 18)} @ 18dp)`);
  console.log("order.nonce          :", order.nonce.toString());
  console.log("order.expiry         :", order.expiry.toString(), `= ${new Date(Number(order.expiry) * 1000).toISOString()}`);
  console.log("route.addresses      :", route.addresses);
  console.log("route.ratios         :", route.ratios.map((r) => r.toString()));
  console.log("signature (65 bytes) :", signature);

  // ── 2. Re-hash per contract's `hashOrder` + `toEthSignedMessageHash` ──
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ["address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
    [order.benefactor, order.beneficiary, order.collateral_asset,
     order.collateral_amount, order.rusd_amount, order.nonce, order.expiry]
  );
  const orderHash = ethers.keccak256(encoded);
  console.log("\norderHash            :", orderHash);
  const ethSignedHash = ethers.hashMessage(ethers.getBytes(orderHash));  // EIP-191 over the raw 32 bytes
  console.log("ethSignedHash        :", ethSignedHash);

  // ── 3. Recover the signer and compare ──
  const recovered = ethers.recoverAddress(ethSignedHash, signature);
  console.log("\nrecovered signer     :", recovered);
  console.log("on-chain backendSigner:", ON_CHAIN_BACKEND_SIGNER);
  console.log("match                :", recovered.toLowerCase() === ON_CHAIN_BACKEND_SIGNER.toLowerCase());
  console.log("\nHardhat key #0 addr  :", HARDHAT_KEY0_ADDR);
  console.log("recovered == HH key0 :", recovered.toLowerCase() === HARDHAT_KEY0_ADDR.toLowerCase());

  // ── 4. Check on-chain block vs expiry ──
  const tx = await ethers.provider.getTransaction("0xb07729f2f5ddf282d1d8a8a6b4d521dbdabe4038f23bba91ef34ca54b5865dd0");
  if (tx && tx.blockNumber) {
    const blk = await ethers.provider.getBlock(tx.blockNumber);
    console.log(`\ntx block             : ${tx.blockNumber} @ ${new Date(blk.timestamp * 1000).toISOString()}`);
    console.log(`expiry - block.ts    : ${Number(order.expiry) - blk.timestamp} seconds`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
