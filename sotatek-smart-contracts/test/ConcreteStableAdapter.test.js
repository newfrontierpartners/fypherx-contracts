/**
 * ConcreteStableAdapter — the 30%-leg adapter for the 70:30 Earn flow.
 * Same single-tenant, internally-accounted share model as
 * ConcreteAdapterV1, but the underlying is a 6-decimal stablecoin (USDC)
 * rather than 18-decimal FYUSD.
 *
 * Verifies:
 *   - constructor rejects zero / mismatched asset / zero vault
 *   - first deposit mints shares 1:1 with assets (6-dec scale)
 *   - subsequent deposits scale by current price-per-share post-yield
 *   - asset-based withdraw (FYP-41) delivers the requested USDC
 *   - yield accrual flows through totalAssets() without changing shares
 *   - FYP-01 single-tenant binding (only the bound vault may mutate)
 *   - FYP-10 direct Concrete-share transfers don't inflate NAV + sweep
 *   - asset() returns the USDC address
 */
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

// USDC is 6-decimal.
const USDC = 10n ** 6n;

async function deployFixture() {
  const [deployer, vault, otherCaller] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdc = await Mock.deploy("Mock USDC", "USDC", 6);

  const Vault = await ethers.getContractFactory("MockERC4626Vault");
  const concreteVault = await Vault.deploy(
    await usdc.getAddress(),
    "Concrete USDC Vault",
    "ccUSDC",
  );

  const Adapter = await ethers.getContractFactory("ConcreteStableAdapter");
  const adapter = await Adapter.deploy(
    await usdc.getAddress(),
    await concreteVault.getAddress(),
    vault.address,
  );

  return { deployer, vault, otherCaller, usdc, concreteVault, adapter };
}

async function fundAndApprove(usdc, adapter, caller, amount) {
  await usdc.mint(caller.address, amount);
  await usdc.connect(caller).approve(await adapter.getAddress(), amount);
}

describe("ConcreteStableAdapter", () => {
  describe("constructor", () => {
    it("rejects zero stable address", async () => {
      const { concreteVault, vault } = await deployFixture();
      const Adapter = await ethers.getContractFactory("ConcreteStableAdapter");
      await assert.rejects(
        Adapter.deploy(ethers.ZeroAddress, await concreteVault.getAddress(), vault.address),
        /ZeroAddress/,
      );
    });

    it("rejects zero concreteVault address", async () => {
      const { usdc, vault } = await deployFixture();
      const Adapter = await ethers.getContractFactory("ConcreteStableAdapter");
      await assert.rejects(
        Adapter.deploy(await usdc.getAddress(), ethers.ZeroAddress, vault.address),
        /ZeroAddress/,
      );
    });

    it("rejects zero vault address (FYP-01)", async () => {
      const { usdc, concreteVault } = await deployFixture();
      const Adapter = await ethers.getContractFactory("ConcreteStableAdapter");
      await assert.rejects(
        Adapter.deploy(await usdc.getAddress(), await concreteVault.getAddress(), ethers.ZeroAddress),
        /ZeroAddress/,
      );
    });

    it("rejects vault whose asset() doesn't match the stablecoin", async () => {
      const [, vault] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const usdc = await Mock.deploy("USDC", "USDC", 6);
      const other = await Mock.deploy("Other", "OTHER", 6);

      const Vault = await ethers.getContractFactory("MockERC4626Vault");
      const wrongVault = await Vault.deploy(await other.getAddress(), "Wrong", "WRONG");

      const Adapter = await ethers.getContractFactory("ConcreteStableAdapter");
      await assert.rejects(
        Adapter.deploy(await usdc.getAddress(), await wrongVault.getAddress(), vault.address),
        /AdapterAssetMismatch/,
      );
    });
  });

  describe("deposit", () => {
    it("first deposit mints shares 1:1 with assets", async () => {
      const { vault, usdc, adapter, concreteVault } = await deployFixture();
      const amount = 1000n * USDC;
      await fundAndApprove(usdc, adapter, vault, amount);
      await adapter.connect(vault).deposit(amount);

      assert.equal(await adapter.totalShares(), amount);
      assert.equal(await adapter.shareOf(vault.address), amount);
      assert.equal(await adapter.totalAssets(), amount);
      assert.equal(await concreteVault.balanceOf(await adapter.getAddress()), amount);
    });

    it("rejects zero amount", async () => {
      const { vault, usdc, adapter } = await deployFixture();
      await fundAndApprove(usdc, adapter, vault, 1n);
      await assert.rejects(adapter.connect(vault).deposit(0), /ZeroAmount/);
    });

    it("a deposit AFTER yield mints fewer shares than 1:1", async () => {
      const { deployer, vault, usdc, adapter, concreteVault } = await deployFixture();
      const v1 = 1000n * USDC;
      await fundAndApprove(usdc, adapter, vault, v1);
      await adapter.connect(vault).deposit(v1);

      const yield_ = 100n * USDC;
      await usdc.mint(deployer.address, yield_);
      await usdc.connect(deployer).approve(await concreteVault.getAddress(), yield_);
      await concreteVault.connect(deployer).simulateYield(yield_);

      const v2 = 110n * USDC;
      await fundAndApprove(usdc, adapter, vault, v2);
      await adapter.connect(vault).deposit(v2);

      const newShares = (await adapter.shareOf(vault.address)) - v1;
      assert.ok(newShares < v2, "fewer shares minted than assets deposited (post-yield)");
      assert.ok(newShares >= 99n * USDC && newShares <= 100n * USDC + 1n,
        `expected ~100e6 new shares, got ${newShares}`);
    });
  });

  describe("withdraw (asset-based, FYP-41)", () => {
    it("burns shares + sends proportional USDC to caller", async () => {
      const { vault, usdc, adapter } = await deployFixture();
      const amount = 1000n * USDC;
      await fundAndApprove(usdc, adapter, vault, amount);
      await adapter.connect(vault).deposit(amount);

      const before = await usdc.balanceOf(vault.address);
      await adapter.connect(vault).withdraw(amount);
      const after = await usdc.balanceOf(vault.address);

      assert.equal(after - before, amount, "1:1 withdraw with no yield");
      assert.equal(await adapter.shareOf(vault.address), 0n);
      assert.equal(await adapter.totalShares(), 0n);
    });

    it("delivers yield-inclusive amount on full post-yield withdraw", async () => {
      const { deployer, vault, usdc, adapter, concreteVault } = await deployFixture();
      const principal = 1000n * USDC;
      const yield_ = 100n * USDC;
      await fundAndApprove(usdc, adapter, vault, principal);
      await adapter.connect(vault).deposit(principal);

      await usdc.mint(deployer.address, yield_);
      await usdc.connect(deployer).approve(await concreteVault.getAddress(), yield_);
      await concreteVault.connect(deployer).simulateYield(yield_);

      const ta = await adapter.totalAssets();
      const before = await usdc.balanceOf(vault.address);
      await adapter.connect(vault).withdraw(ta);
      const after = await usdc.balanceOf(vault.address);

      assert.equal(after - before, ta);
      assert.equal(await adapter.totalShares(), 0n);
    });

    it("rejects withdraw beyond totalAssets", async () => {
      const { vault, usdc, adapter } = await deployFixture();
      const amount = 1000n * USDC;
      await fundAndApprove(usdc, adapter, vault, amount);
      await adapter.connect(vault).deposit(amount);
      await assert.rejects(adapter.connect(vault).withdraw(amount + 1n), /InsufficientAssets/);
    });

    it("rejects zero amount", async () => {
      const { vault, adapter } = await deployFixture();
      await assert.rejects(adapter.connect(vault).withdraw(0), /ZeroAmount/);
    });
  });

  describe("single-tenant binding (FYP-01)", () => {
    it("rejects deposit from non-vault caller", async () => {
      const { otherCaller, usdc, adapter } = await deployFixture();
      await fundAndApprove(usdc, adapter, otherCaller, 100n * USDC);
      await assert.rejects(adapter.connect(otherCaller).deposit(100n * USDC), /NotVault/);
    });

    it("rejects withdraw from non-vault caller", async () => {
      const { vault, otherCaller, usdc, adapter } = await deployFixture();
      await fundAndApprove(usdc, adapter, vault, 100n * USDC);
      await adapter.connect(vault).deposit(100n * USDC);
      await assert.rejects(adapter.connect(otherCaller).withdraw(1n), /NotVault/);
    });
  });

  describe("excess-share sweep (FYP-10)", () => {
    it("totalAssets ignores direct Concrete-share transfers", async () => {
      const { vault, otherCaller, usdc, concreteVault, adapter } = await deployFixture();
      await fundAndApprove(usdc, adapter, vault, 1000n * USDC);
      await adapter.connect(vault).deposit(1000n * USDC);
      const taBefore = await adapter.totalAssets();

      await usdc.mint(otherCaller.address, 500n * USDC);
      await usdc.connect(otherCaller).approve(await concreteVault.getAddress(), 500n * USDC);
      await concreteVault.connect(otherCaller).deposit(500n * USDC, otherCaller.address);
      const cShares = await concreteVault.balanceOf(otherCaller.address);
      await concreteVault.connect(otherCaller).transfer(await adapter.getAddress(), cShares);

      assert.equal(await adapter.totalAssets(), taBefore,
        "direct Concrete-share transfer does not inflate NAV");
    });

    it("sweepConcreteShares forwards the excess + rejects non-vault callers", async () => {
      const { deployer, vault, otherCaller, usdc, concreteVault, adapter } = await deployFixture();
      await fundAndApprove(usdc, adapter, vault, 1000n * USDC);
      await adapter.connect(vault).deposit(1000n * USDC);

      await usdc.mint(otherCaller.address, 250n * USDC);
      await usdc.connect(otherCaller).approve(await concreteVault.getAddress(), 250n * USDC);
      await concreteVault.connect(otherCaller).deposit(250n * USDC, otherCaller.address);
      const cShares = await concreteVault.balanceOf(otherCaller.address);
      await concreteVault.connect(otherCaller).transfer(await adapter.getAddress(), cShares);

      await assert.rejects(
        adapter.connect(otherCaller).sweepConcreteShares(deployer.address),
        /NotVault/,
      );

      const before = await concreteVault.balanceOf(deployer.address);
      await adapter.connect(vault).sweepConcreteShares(deployer.address);
      const after = await concreteVault.balanceOf(deployer.address);
      assert.equal(after - before, cShares);

      await assert.rejects(
        adapter.connect(vault).sweepConcreteShares(deployer.address),
        /NoExcessShares/,
      );
    });
  });

  describe("views", () => {
    it("asset() returns the USDC address", async () => {
      const { usdc, adapter } = await deployFixture();
      assert.equal((await adapter.asset()).toLowerCase(), (await usdc.getAddress()).toLowerCase());
    });

    it("realizedYield7d returns 0 (off-chain subgraph reader)", async () => {
      const { adapter } = await deployFixture();
      assert.equal(await adapter.realizedYield7d(), 0n);
    });
  });
});
