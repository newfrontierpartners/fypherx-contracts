/**
 * FypherMinting — post-merge test surface.
 *
 * Covers two layered concerns:
 *
 *  1. The April-audit P0 patches that landed on `main` (EIP-712 typed
 *     data + OrderType-bound digest, route validation, escrow-keyed
 *     redeem flow, mintWETH deprecation).
 *  2. The S1.2 / ADR-008 per-asset mint pause + pauserRole carve-out.
 *
 * The mintWETH wrap path that S1.2 originally tried to "fix" is gone:
 * audit kept the function as a permanently-reverting stub, and any
 * native-token mint flow now goes through {mint} with a wrapped-native
 * ERC20 as `collateral_asset`.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades } = require("hardhat");

const ONE = 10n ** 18n;

// EIP-712 type hash — must match FypherMinting.ORDER_TYPEHASH bytes32
// (i.e. keccak256 of the canonical type string).
const ORDER_TYPE_STRING =
  "Order(uint8 orderType,address benefactor,address beneficiary,address collateral_asset,uint256 collateral_amount,uint256 rusd_amount,uint256 nonce,uint256 expiry)";

const ORDER_TYPES = {
  Order: [
    { name: "orderType",         type: "uint8"   },
    { name: "benefactor",        type: "address" },
    { name: "beneficiary",       type: "address" },
    { name: "collateral_asset",  type: "address" },
    { name: "collateral_amount", type: "uint256" },
    { name: "rusd_amount",       type: "uint256" },
    { name: "nonce",             type: "uint256" },
    { name: "expiry",            type: "uint256" },
  ],
};

const ORDER_TYPE = { MINT: 0, REDEEM: 1 };

async function signOrder(signer, mintingAddress, order, orderType) {
  const network = await ethers.provider.getNetwork();
  const domain = {
    name: "FypherMinting",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: mintingAddress,
  };
  const value = { ...order, orderType };
  return signer.signTypedData(domain, ORDER_TYPES, value);
}

async function nowPlus(seconds) {
  const blk = await ethers.provider.getBlock("latest");
  return BigInt(blk.timestamp + seconds);
}

async function deployFixture() {
  const [deployer, alice, backend, executor, pauser, custodian, nonAdmin] =
    await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const RUSD = await ethers.getContractFactory("RUSD");
  const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdt = await MockERC20.deploy("Mock USDT", "mUSDT", 18);

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

  // FypherMinting is the only minter on RUSD.
  await (await rusd.setMinter(await minting.getAddress())).wait();

  // Whitelist USDT + the custodian per April-audit C-4 route validation.
  await (await minting.addSupportedAsset(await usdt.getAddress())).wait();
  await (await minting.addCustodianAddress(custodian.address)).wait();
  await (await minting.setPauserRole(pauser.address)).wait();

  // Seed alice with USDT + approve the minter.
  await (await usdt.mint(alice.address, 10_000n * ONE)).wait();
  await (
    await usdt.connect(alice).approve(await minting.getAddress(), ethers.MaxUint256)
  ).wait();

  return { deployer, alice, backend, executor, pauser, custodian, nonAdmin,
           setting, rusd, usdt, minting };
}

describe("FypherMinting (post-merge: April-audit + S1.2 ADR-008)", () => {
  describe("ORDER_TYPEHASH", () => {
    it("matches the canonical Order type string keccak256", async () => {
      const { minting } = await deployFixture();
      const expected = ethers.keccak256(ethers.toUtf8Bytes(ORDER_TYPE_STRING));
      assert.equal(await minting.ORDER_TYPEHASH(), expected);
    });
  });

  describe("mint happy path", () => {
    it("verifies EIP-712(OrderType.MINT) signature, transfers via custodian route, mints RUSD", async () => {
      const { alice, backend, custodian, usdt, rusd, minting } = await deployFixture();
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 200n * ONE,
        rusd_amount: 200n * ONE,
        nonce: 7n,
        expiry: await nowPlus(600),
      };
      const sig = await signOrder(backend, await minting.getAddress(), order, ORDER_TYPE.MINT);
      const route = { addresses: [custodian.address], ratios: [10000] };

      await (await minting.connect(alice).mint(order, route, sig)).wait();

      assert.equal(await usdt.balanceOf(custodian.address), 200n * ONE);
      assert.equal(await rusd.balanceOf(alice.address), 200n * ONE);
      assert.equal(await minting.verifyNonce(alice.address, 7n), false); // burnt
    });

    it("rejects an order signed with OrderType.REDEEM (replay protection across types)", async () => {
      const { alice, backend, custodian, usdt, minting } = await deployFixture();
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 50n * ONE,
        rusd_amount: 50n * ONE,
        nonce: 11n,
        expiry: await nowPlus(600),
      };
      // Wrong OrderType — would have worked under the legacy non-typed sig.
      const sig = await signOrder(backend, await minting.getAddress(), order, ORDER_TYPE.REDEEM);
      const route = { addresses: [custodian.address], ratios: [10000] };
      await assert.rejects(
        minting.connect(alice).mint(order, route, sig),
        (err) => err.message.includes("InvalidSignature"),
      );
    });

    it("rejects routes with non-custodian destinations or wrong ratio sum (C-4)", async () => {
      const { alice, backend, custodian, nonAdmin, usdt, minting } = await deployFixture();
      const baseOrder = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 50n * ONE,
        rusd_amount: 50n * ONE,
        nonce: 21n,
        expiry: await nowPlus(600),
      };
      const sig = await signOrder(backend, await minting.getAddress(), baseOrder, ORDER_TYPE.MINT);

      // nonAdmin is NOT a whitelisted custodian — must revert InvalidRoute.
      await assert.rejects(
        minting.connect(alice).mint(baseOrder, { addresses: [nonAdmin.address], ratios: [10000] }, sig),
        (err) => err.message.includes("InvalidRoute"),
      );

      // Ratios summing to !=10000 — revert InvalidRoute.
      const splitOrder = { ...baseOrder, nonce: 22n };
      const splitSig = await signOrder(backend, await minting.getAddress(), splitOrder, ORDER_TYPE.MINT);
      await assert.rejects(
        minting.connect(alice).mint(splitOrder, { addresses: [custodian.address], ratios: [9999] }, splitSig),
        (err) => err.message.includes("InvalidRoute"),
      );
    });
  });

  describe("S1.2 / ADR-008 — per-asset mint pause", () => {
    it("setMintPaused(true) by pauser blocks mint for that asset only", async () => {
      const { alice, backend, custodian, pauser, usdt, minting } = await deployFixture();
      await (
        await minting.connect(pauser).setMintPaused(await usdt.getAddress(), true)
      ).wait();
      assert.equal(await minting.mintPaused(await usdt.getAddress()), true);

      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 100n * ONE,
        rusd_amount: 100n * ONE,
        nonce: 31n,
        expiry: await nowPlus(600),
      };
      const sig = await signOrder(backend, await minting.getAddress(), order, ORDER_TYPE.MINT);
      const route = { addresses: [custodian.address], ratios: [10000] };
      await assert.rejects(
        minting.connect(alice).mint(order, route, sig),
        (err) => err.message.includes("MintPausedForAsset"),
      );
    });

    it("setMintPaused(false) is admin-only — pauser cannot unpause", async () => {
      const { deployer, pauser, usdt, minting } = await deployFixture();
      await (
        await minting.connect(pauser).setMintPaused(await usdt.getAddress(), true)
      ).wait();
      await assert.rejects(
        minting.connect(pauser).setMintPaused(await usdt.getAddress(), false),
        (err) => err.message.includes("NotAdmin"),
      );
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

    it("legacy disableMintRedeem still acts as the global kill switch", async () => {
      const { deployer, alice, backend, custodian, usdt, minting } = await deployFixture();
      await (await minting.connect(deployer).disableMintRedeem(true)).wait();
      const order = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 50n * ONE,
        rusd_amount: 50n * ONE,
        nonce: 41n,
        expiry: await nowPlus(600),
      };
      const sig = await signOrder(backend, await minting.getAddress(), order, ORDER_TYPE.MINT);
      const route = { addresses: [custodian.address], ratios: [10000] };
      await assert.rejects(
        minting.connect(alice).mint(order, route, sig),
        (err) => err.message.includes("MintRedeemDisabled"),
      );
    });
  });

  describe("mintWETH — permanently deprecated (audit P0)", () => {
    it("reverts DeprecatedFunction for any caller, ignoring msg.value", async () => {
      const { alice, usdt, minting } = await deployFixture();
      const dummyOrder = {
        benefactor: alice.address,
        beneficiary: alice.address,
        collateral_asset: await usdt.getAddress(),
        collateral_amount: 1n,
        rusd_amount: 1n,
        nonce: 51n,
        expiry: await nowPlus(600),
      };
      await assert.rejects(
        minting.connect(alice).mintWETH(dummyOrder, { addresses: [], ratios: [] }, "0x", { value: ethers.parseEther("1") }),
        (err) => err.message.includes("DeprecatedFunction"),
      );
    });
  });

  describe("admin guards (S1.2)", () => {
    it("setPauserRole is admin-only", async () => {
      const { nonAdmin, minting } = await deployFixture();
      await assert.rejects(
        minting.connect(nonAdmin).setPauserRole(nonAdmin.address),
        (err) => err.message.includes("NotAdmin"),
      );
    });
  });
});
