/**
 * Deploy a fresh Gnosis Safe via the canonical SafeProxyFactory.
 *
 * Reads the signer set from `multisig-signers.<network>.json` (gitignored,
 * per-environment). The threshold defaults to the spec value in
 * safe-config.js but can be overridden in the JSON.
 *
 * Usage:
 *   npx hardhat run scripts/multisig/deploy-safe.js --network bscTestnet
 *
 * After this runs, the new Safe address is appended to the addresses
 * file (deployed-addresses.json today; addresses/{chainId}.json after
 * S1.9). The next step is `transfer-admin.js` which calls
 * SettingManagement.transferAdmin(<safe>) from the current EOA admin,
 * followed by the Safe-side acceptAdmin (see print-accept-admin.js).
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { getSafeConfig, SAFE_PROXY_FACTORY_ABI, SAFE_SINGLETON_ABI } = require("./safe-config");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const cfg = getSafeConfig(chainId);

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Multisig Safe deploy — ${cfg.name} (chainId ${chainId})`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("Deployer EOA:", deployer.address);

  // Load signer set.
  const signerFile = path.join(
    __dirname, "..", "..", `multisig-signers.${network.name}.json`
  );
  if (!fs.existsSync(signerFile)) {
    console.error(
      `\nERROR: ${path.basename(signerFile)} not found.\n` +
      `Copy docs/decisions/multisig-signers.example.md → ` +
      `${path.basename(signerFile)} and populate the signer addresses.`
    );
    process.exit(1);
  }
  const signerConfig = JSON.parse(fs.readFileSync(signerFile, "utf8"));
  const owners = signerConfig.owners.map(ethers.getAddress);
  const threshold = signerConfig.threshold ?? cfg.threshold;

  if (owners.length === 0) throw new Error("No owners in signer config");
  if (threshold < 1 || threshold > owners.length) {
    throw new Error(`Bad threshold ${threshold} for ${owners.length} owners`);
  }
  console.log(`Owners (${owners.length}):`);
  for (const o of owners) console.log(`  ${o}`);
  console.log(`Threshold: ${threshold}-of-${owners.length}`);

  // Encode the Safe.setup() initializer.
  const singletonIface = new ethers.Interface(SAFE_SINGLETON_ABI);
  const initializer = singletonIface.encodeFunctionData("setup", [
    owners,
    threshold,
    ethers.ZeroAddress,           // to
    "0x",                          // data
    cfg.fallbackHandler,           // fallbackHandler
    ethers.ZeroAddress,            // paymentToken
    0,                             // payment
    ethers.ZeroAddress,            // paymentReceiver
  ]);

  // Deterministic salt: hash(owners + threshold + chainId + block.timestamp).
  // Including block.timestamp keeps redeploys distinct so we don't collide
  // on a previously-deployed Safe with the same owner set on the same chain.
  const block = await ethers.provider.getBlock("latest");
  const saltNonce = BigInt(
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address[]", "uint256", "uint256", "uint256"],
        [owners, threshold, chainId, block.timestamp],
      ),
    ),
  );
  console.log(`SaltNonce: ${saltNonce.toString(16)}`);

  // Deploy via SafeProxyFactory.createProxyWithNonce.
  const factory = new ethers.Contract(cfg.proxyFactory, SAFE_PROXY_FACTORY_ABI, deployer);
  console.log(`\nFactory: ${cfg.proxyFactory}`);
  console.log(`Singleton: ${cfg.singleton}`);
  console.log("Deploying Safe proxy...");

  const tx = await factory.createProxyWithNonce(cfg.singleton, initializer, saltNonce);
  const receipt = await tx.wait();
  console.log(`  tx: ${receipt.hash}`);

  // Pull ProxyCreation event for the deployed address.
  const proxyEvent = receipt.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "ProxyCreation");
  if (!proxyEvent) throw new Error("ProxyCreation event not found in receipt");
  const safeAddress = proxyEvent.args.proxy;
  console.log(`\n✓ Safe deployed at: ${safeAddress}`);

  // Verify it's wired correctly.
  const safe = new ethers.Contract(safeAddress, SAFE_SINGLETON_ABI, deployer);
  const onChainOwners = await safe.getOwners();
  const onChainThreshold = await safe.getThreshold();
  console.log(`  Verified owners: ${onChainOwners.length}`);
  console.log(`  Verified threshold: ${onChainThreshold}`);
  if (onChainOwners.length !== owners.length) throw new Error("Owner count mismatch");
  if (Number(onChainThreshold) !== threshold) throw new Error("Threshold mismatch");

  // Append to addresses file. Pre-S1.9 layout uses deployed-addresses.json;
  // post-S1.9 will use addresses/{chainId}.json — script handles both.
  const flatAddrPath = path.join(__dirname, "..", "..", "deployed-addresses.json");
  const perChainDir = path.join(__dirname, "..", "..", "addresses");
  const perChainPath = path.join(perChainDir, `${chainId}.json`);
  let addrs = {};
  if (fs.existsSync(perChainPath)) {
    addrs = JSON.parse(fs.readFileSync(perChainPath, "utf8"));
    addrs.MultisigSafe = safeAddress;
    fs.writeFileSync(perChainPath, JSON.stringify(addrs, null, 2));
    console.log(`\n✓ Wrote MultisigSafe to ${path.relative(process.cwd(), perChainPath)}`);
  } else if (fs.existsSync(flatAddrPath)) {
    addrs = JSON.parse(fs.readFileSync(flatAddrPath, "utf8"));
    addrs.MultisigSafe = safeAddress;
    fs.writeFileSync(flatAddrPath, JSON.stringify(addrs, null, 2));
    console.log(`\n✓ Wrote MultisigSafe to ${path.basename(flatAddrPath)}`);
  } else {
    console.warn(
      "\nWARNING: neither deployed-addresses.json nor addresses/${chainId}.json found. " +
      `Safe address NOT persisted. Address: ${safeAddress}`,
    );
  }

  console.log("\nNext steps (per ADR-007):");
  console.log("  1. Run scripts/multisig/transfer-admin.js to call ");
  console.log("     SettingManagement.transferAdmin(safeAddress) from the");
  console.log("     current EOA admin.");
  console.log("  2. Run scripts/multisig/print-accept-admin.js to get the");
  console.log("     calldata the multisig signers must execute on the Safe");
  console.log("     UI (https://app.safe.global) to call acceptAdmin().");
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
