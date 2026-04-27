/**
 * FypherMinting — S1.2 surface tests.
 *
 * Focus: the new behaviour added in S1.2 (per-asset mint pause + pauser
 * carve-out + mintWETH that actually wraps msg.value). Pre-existing
 * mint/redeem ABI is exercised end-to-end as part of the happy paths.
 *
 * NOTE: storage layout compatibility with the BSC Testnet proxy at
 *       0x0Cc3De38A1ff577f23d14a4714530FCc11b24690 is enforced at deploy
 *       time by @openzeppelin/hardhat-upgrades' validation; this file
 *       does not re-test that.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades } = require("hardhat");

const ONE = 10n ** 18n;

async function signOrder(signer, order) {
  const orderHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
      [
        order.benefactor,
        order.beneficiary,
        order.collateral_asset,
        order.collateral_amount,
        order.rusd_amount,
        order.nonce,
        order.expiry,
      ],
    ),
  );
  return signer.signMessage(ethers.getBytes(orderHash));
}

async function deployFixture() {
  const [deployer, alice, backend, executor, pauser, custodian, nonAdmin] =
    await ethers.getSigners();

  // SettingManagement (admin = deployer).
  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize",
    kind: "transparent",
  });

  // RUSD with deployer as the (only) minter for test seeding; later we
  // hand the minter off to FypherMinting so it can mint inside `mint()`.
  const RUSD = await ethers.getContractFactory("RUSD");
  const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
    initializer: "initialize",
    kind: "transparent",
  });

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdt = await MockERC20.deploy("Mock USDT", "mUSDT", 18);

  const MockWETH = await ethers.getContractFactory("MockWETH");
  const weth = await MockWETH.deploy();

  // FypherMinting.
  const Minting = await ethers.getContractFactory("FypherMinting");
  const minting = await upgrades.deployProxy(
    Minting,
    [
      await setting.getAddress(),
      await rusd.getAddress(),
      backend.address,
      executor.address,
    ],
    { initializer: "initialize", kind: "transparent" },
  );

  // Wire RUSD minter to FypherMinting so mint() can call IRUSD.mint inside.
  await (await rusd.setMinter(await minting.getAddress())).wait();

  // Configure: support both USDT and WETH; set wrappedNative; set pauser.
  await (await minting.addSupportedAsset(await usdt.getAddress())).wait();
  await (await minting.addSupportedAsset(await weth.getAddress())).wait();
  await (await minting.setWrappedNative(await weth.getAddress())).wait();
  await (await minting.setPauserRole(pauser.address)).wait();

  // Seed alice with USDT + approve.
  await (await usdt.mint(alice.address, 10_000n * ONE)).wait();
  await (
    await usdt.connect(alice).approve(await minting.getAddress(), ethers.MaxUint256)
  ).wait();

  return {
    deployer, alice, backend, executor, pauser, custodian, nonAdmin,
    setting, rusd, usdt, weth, minting,
  };
}

describe("FypherMinting (S1.2 refactor)", () => {
  describe("per-asset mint pause", () => {
    it("setMintPaused(true) by pauser blocks mint() for that asset only", async () => {
      const { alice, backend, pauser, usdt, weth, minting } = await deployFixture();
      // Pause USDT only.
      await (
        await minting.connect(pauser).setMintPaused(await usdt.getAddress(), true)
      ).wait();
      assert.equal(await minting.mintPaused(await usdt.getAddress()), true);
      assert.equal(await minting.mintPaused(await weth.getAddress()), false);

      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 100n * ONE,
        rusd_amount: 100n * ONE,
        nonce: 1n,
        expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 600),
      };
      const sig = await signOrder(backend, order);
      const route = { addresses: [pauser.address], ratios: [10000] };
      await assert.rejects(
        minting.connect(alice).mint(order, route, sig),
        (err) => err.message.includes("MintPausedForAsset"),
      );
    });

    it("setMintPaused(false) requires admin (multisig) — pauser cannot unpause", async () => {
      const { deployer, pauser, usdt, minting } = await deployFixture();
      await (
        await minting.connect(pauser).setMintPaused(await usdt.getAddress(), true)
      ).wait();
      // Pauser tries to unpause — must revert NotAdmin.
      await assert.rejects(
        minting.connect(pauser).setMintPaused(await usdt.getAddress(), false),
        (err) => err.message.includes("NotAdmin"),
      );
      // Admin (deployer) can unpause.
      await (
        await minting.connect(deployer).setMintPaused(await usdt.getAddress(), false)
      ).wait();
      assert.equal(await minting.mintPaused(await usdt.getAddress()), false);
    });

    it("non-pauser, non-admin cannot pause", async () => {
      const { nonAdmin, usdt, minting } = await deployFixture();
      await assert.rejects(
        minting.connect(nonAdmin).setMintPaused(await usdt.getAddress(), true),
        (err) => err.message.includes("NotPauserOrAdmin"),
      );
    });

    it("legacy disableMintRedeem still gates everything (defense in depth)", async () => {
      const { deployer, alice, backend, pauser, usdt, minting } = await deployFixture();
      await (await minting.connect(deployer).disableMintRedeem(true)).wait();
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 50n * ONE,
        rusd_amount: 50n * ONE,
        nonce: 99n,
        expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 600),
      };
      const sig = await signOrder(backend, order);
      const route = { addresses: [pauser.address], ratios: [10000] };
      await assert.rejects(
        minting.connect(alice).mint(order, route, sig),
        (err) => err.message.includes("MintRedeemDisabled"),
      );
    });
  });

  describe("mint happy path (regression)", () => {
    it("transfers USDT to custodian and mints RUSD to beneficiary", async () => {
      const { alice, backend, custodian, usdt, rusd, minting } = await deployFixture();
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 200n * ONE,
        rusd_amount: 200n * ONE,
        nonce: 7n,
        expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 600),
      };
      const sig = await signOrder(backend, order);
      const route = { addresses: [custodian.address], ratios: [10000] };

      await (await minting.connect(alice).mint(order, route, sig)).wait();

      assert.equal(await usdt.balanceOf(custodian.address), 200n * ONE);
      assert.equal(await rusd.balanceOf(alice.address), 200n * ONE);
      assert.equal(await minting.verifyNonce(alice.address, 7n), false);
    });
  });

  describe("mintWETH (S1.2 fix — actually wraps msg.value)", () => {
    it("requires msg.value == order.collateral_amount", async () => {
      const { alice, backend, weth, minting, custodian } = await deployFixture();
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await weth.getAddress(),
        collateral_amount: ethers.parseEther("1"),
        rusd_amount: 1000n * ONE,
        nonce: 11n,
        expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 600),
      };
      const sig = await signOrder(backend, order);
      const route = { addresses: [custodian.address], ratios: [10000] };

      // msg.value too low.
      await assert.rejects(
        minting.connect(alice).mintWETH(order, route, sig, { value: ethers.parseEther("0.5") }),
        (err) => err.message.includes("WrongMsgValue"),
      );

      // msg.value too high.
      await assert.rejects(
        minting.connect(alice).mintWETH(order, route, sig, { value: ethers.parseEther("2") }),
        (err) => err.message.includes("WrongMsgValue"),
      );
    });

    it("rejects non-wrapped-native collateral_asset", async () => {
      const { alice, backend, usdt, minting, custodian } = await deployFixture();
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: ethers.parseEther("1"),
        rusd_amount: 100n * ONE,
        nonce: 13n,
        expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 600),
      };
      const sig = await signOrder(backend, order);
      const route = { addresses: [custodian.address], ratios: [10000] };
      await assert.rejects(
        minting.connect(alice).mintWETH(order, route, sig, { value: ethers.parseEther("1") }),
        (err) => err.message.includes("UnsupportedAsset"),
      );
    });

    it("happy path wraps msg.value, forwards WETH, mints RUSD", async () => {
      const { alice, backend, custodian, weth, rusd, minting } = await deployFixture();
      const value = ethers.parseEther("1.5");
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await weth.getAddress(),
        collateral_amount: value,
        rusd_amount: 4500n * ONE,  // 1.5 ETH @ $3000 example, contract is price-agnostic
        nonce: 21n,
        expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 600),
      };
      const sig = await signOrder(backend, order);
      const route = { addresses: [custodian.address], ratios: [10000] };

      const aliceEthBefore = await ethers.provider.getBalance(alice.address);
      const tx = await minting.connect(alice).mintWETH(order, route, sig, { value });
      const receipt = await tx.wait();

      // Custodian got the WETH.
      assert.equal(await weth.balanceOf(custodian.address), value);
      // Alice got the RUSD.
      assert.equal(await rusd.balanceOf(alice.address), 4500n * ONE);
      // Alice paid value + gas in native ETH.
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const aliceEthAfter = await ethers.provider.getBalance(alice.address);
      assert.equal(aliceEthBefore - aliceEthAfter, value + gasUsed);
      // FypherMinting holds no leftover WETH (full forward).
      assert.equal(await weth.balanceOf(await minting.getAddress()), 0n);
    });

    it("blocked when wrappedNative not configured", async () => {
      // Fresh fixture without setWrappedNative call.
      const [deployer, alice, backend, executor] = await ethers.getSigners();
      const SettingManagement = await ethers.getContractFactory("SettingManagement");
      const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
        initializer: "initialize", kind: "transparent",
      });
      const RUSD = await ethers.getContractFactory("RUSD");
      const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
        initializer: "initialize", kind: "transparent",
      });
      const Minting = await ethers.getContractFactory("FypherMinting");
      const minting = await upgrades.deployProxy(Minting, [
        await setting.getAddress(), await rusd.getAddress(), backend.address, executor.address,
      ], { initializer: "initialize", kind: "transparent" });
      await (await rusd.setMinter(await minting.getAddress())).wait();

      const MockWETH = await ethers.getContractFactory("MockWETH");
      const weth = await MockWETH.deploy();
      // Add as supported asset but DON'T set wrappedNative.
      await (await minting.addSupportedAsset(await weth.getAddress())).wait();

      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await weth.getAddress(),
        collateral_amount: ethers.parseEther("1"),
        rusd_amount: 100n * ONE,
        nonce: 31n,
        expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 600),
      };
      const sig = await signOrder(backend, order);
      const route = { addresses: [deployer.address], ratios: [10000] };
      await assert.rejects(
        minting.connect(alice).mintWETH(order, route, sig, { value: ethers.parseEther("1") }),
        (err) => err.message.includes("WrappedNativeNotSet"),
      );
    });

    it("respects per-asset pause for WETH", async () => {
      const { alice, backend, pauser, custodian, weth, minting } = await deployFixture();
      await (
        await minting.connect(pauser).setMintPaused(await weth.getAddress(), true)
      ).wait();
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await weth.getAddress(),
        collateral_amount: ethers.parseEther("1"),
        rusd_amount: 100n * ONE,
        nonce: 41n,
        expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 600),
      };
      const sig = await signOrder(backend, order);
      const route = { addresses: [custodian.address], ratios: [10000] };
      await assert.rejects(
        minting.connect(alice).mintWETH(order, route, sig, { value: ethers.parseEther("1") }),
        (err) => err.message.includes("MintPausedForAsset"),
      );
    });
  });

  describe("admin guards", () => {
    it("setPauserRole / setWrappedNative are admin-only", async () => {
      const { nonAdmin, weth, minting } = await deployFixture();
      await assert.rejects(
        minting.connect(nonAdmin).setPauserRole(nonAdmin.address),
        (err) => err.message.includes("NotAdmin"),
      );
      await assert.rejects(
        minting.connect(nonAdmin).setWrappedNative(await weth.getAddress()),
        (err) => err.message.includes("NotAdmin"),
      );
    });
  });
});
