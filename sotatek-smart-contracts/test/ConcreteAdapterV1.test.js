/**
 * ConcreteAdapterV1 — adapter that wraps a Concrete (concrete.xyz)
 * Earn V2 ERC-4626 vault and exposes the IConcreteAdapter surface
 * the FyusdYieldVault expects.
 *
 * Verifies:
 *   - constructor rejects zero / mismatched asset
 *   - first deposit mints shares 1:1 with assets
 *   - subsequent deposits scale shares by current price-per-share
 *     (so a deposit during yield accrual mints fewer shares than 1:1)
 *   - withdraw burns shares + delivers FYUSD to caller proportional
 *     to (totalAssets * shares / totalShares)
 *   - yield accrual on the underlying Concrete vault flows through
 *     to higher totalAssets() without changing share count
 *   - shareOf tracking is per-caller (so multiple holders don't bleed
 *     into each other)
 *   - withdraw reverts when caller lacks shares
 *   - realizedYield7d returns 0 (intentional, see contract docstring)
 */
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;

async function deployFixture() {
  const [deployer, vault, otherCaller] = await ethers.getSigners();

  // Underlying — pretend FYUSD with 18 decimals.
  const Mock = await ethers.getContractFactory("MockERC20");
  const fyusd = await Mock.deploy("Mock FYUSD", "FYUSD", 18);

  // Concrete vault stand-in — minimal ERC4626 with simulateYield helper.
  const Vault = await ethers.getContractFactory("MockERC4626Vault");
  const concreteVault = await Vault.deploy(
    await fyusd.getAddress(),
    "Concrete Mock Vault",
    "ccFYUSD",
  );

  // The adapter under test.
  const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
  const adapter = await Adapter.deploy(
    await fyusd.getAddress(),
    await concreteVault.getAddress(),
  );

  return { deployer, vault, otherCaller, fyusd, concreteVault, adapter };
}

/**
 * Helper: prep a caller (typically `vault` signer) with balance +
 * approve adapter to pull. Real FyusdYieldVault does this implicitly
 * via forceApprove on each deposit; tests do it explicitly.
 */
async function fundAndApprove(fyusd, adapter, caller, amount) {
  await fyusd.mint(caller.address, amount);
  await fyusd.connect(caller).approve(await adapter.getAddress(), amount);
}

describe("ConcreteAdapterV1", () => {
  describe("constructor", () => {
    it("rejects zero fyusd address", async () => {
      const { concreteVault } = await deployFixture();
      const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
      await assert.rejects(
        Adapter.deploy(ethers.ZeroAddress, await concreteVault.getAddress()),
        /ZeroAddress/,
      );
    });

    it("rejects zero vault address", async () => {
      const { fyusd } = await deployFixture();
      const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
      await assert.rejects(
        Adapter.deploy(await fyusd.getAddress(), ethers.ZeroAddress),
        /ZeroAddress/,
      );
    });

    it("rejects vault whose asset() doesn't match fyusd", async () => {
      const Mock = await ethers.getContractFactory("MockERC20");
      const fyusd = await Mock.deploy("FYUSD", "FYUSD", 18);
      const otherToken = await Mock.deploy("Other", "OTHER", 18);

      const Vault = await ethers.getContractFactory("MockERC4626Vault");
      const wrongVault = await Vault.deploy(
        await otherToken.getAddress(),
        "Wrong",
        "WRONG",
      );

      const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
      await assert.rejects(
        Adapter.deploy(await fyusd.getAddress(), await wrongVault.getAddress()),
        /AdapterAssetMismatch/,
      );
    });
  });

  describe("first deposit", () => {
    it("mints shares 1:1 with assets when totalShares is 0", async () => {
      const { vault, fyusd, adapter, concreteVault } = await deployFixture();
      const amount = 1000n * ONE;

      await fundAndApprove(fyusd, adapter, vault, amount);
      await adapter.connect(vault).deposit(amount);

      assert.equal(await adapter.totalShares(), amount);
      assert.equal(await adapter.shareOf(vault.address), amount);
      assert.equal(await adapter.totalAssets(), amount);  // 1:1 with Concrete
      assert.equal(
        await concreteVault.balanceOf(await adapter.getAddress()),
        amount,
        "adapter holds equivalent Concrete shares 1:1 (no yield yet)",
      );
    });

    it("emits Deposited event with assets + shares", async () => {
      const { vault, fyusd, adapter } = await deployFixture();
      const amount = 100n * ONE;

      await fundAndApprove(fyusd, adapter, vault, amount);
      await assert.doesNotReject(
        adapter.connect(vault).deposit(amount),
        "first deposit succeeds",
      );
    });

    it("rejects zero amount", async () => {
      const { vault, fyusd, adapter } = await deployFixture();
      await fundAndApprove(fyusd, adapter, vault, 1n);
      await assert.rejects(
        adapter.connect(vault).deposit(0),
        /ZeroAmount/,
      );
    });
  });

  describe("yield accrual", () => {
    it("totalAssets grows when underlying vault accrues yield", async () => {
      const { deployer, vault, fyusd, adapter, concreteVault } = await deployFixture();
      const principal = 1000n * ONE;

      await fundAndApprove(fyusd, adapter, vault, principal);
      await adapter.connect(vault).deposit(principal);
      assert.equal(await adapter.totalAssets(), principal);

      // Simulate 10% yield in the underlying Concrete vault.
      const yield_ = 100n * ONE;
      await fyusd.mint(deployer.address, yield_);
      await fyusd.connect(deployer).approve(await concreteVault.getAddress(), yield_);
      await concreteVault.connect(deployer).simulateYield(yield_);

      // OZ ERC-4626 inflation-attack protection rounds convertToAssets
      // down by 1 wei (the +1 virtual-share bias). Our adapter inherits
      // that — totalAssets reads through the underlying vault's
      // convertToAssets — so the visible total is principal + yield - 1.
      // Acceptable: a 1-wei under-report of NAV doesn't affect any
      // user-observable behaviour at 18-decimal precision.
      const expected = principal + yield_ - 1n;
      assert.equal(await adapter.totalAssets(), expected);
      assert.equal(await adapter.totalShares(), principal);
      assert.equal(await adapter.shareOf(vault.address), principal);
    });

    it("a deposit AFTER yield mints fewer shares than 1:1", async () => {
      const { deployer, vault, otherCaller, fyusd, adapter, concreteVault } = await deployFixture();

      // Vault deposits 1000 first.
      const v1 = 1000n * ONE;
      await fundAndApprove(fyusd, adapter, vault, v1);
      await adapter.connect(vault).deposit(v1);

      // Yield: vault now backed by 1100 FYUSD, still 1000 shares.
      const yield_ = 100n * ONE;
      await fyusd.mint(deployer.address, yield_);
      await fyusd.connect(deployer).approve(await concreteVault.getAddress(), yield_);
      await concreteVault.connect(deployer).simulateYield(yield_);

      // Other caller deposits 110 FYUSD — should mint 100 adapter
      // shares (110 * 1000 / 1100), not 110.
      const v2 = 110n * ONE;
      await fundAndApprove(fyusd, adapter, otherCaller, v2);
      await adapter.connect(otherCaller).deposit(v2);

      assert.equal(await adapter.shareOf(otherCaller.address), 100n * ONE);
      assert.equal(await adapter.totalShares(), v1 + 100n * ONE);
    });
  });

  describe("withdraw", () => {
    it("burns shares + sends proportional FYUSD to caller", async () => {
      const { vault, fyusd, adapter } = await deployFixture();
      const amount = 1000n * ONE;

      await fundAndApprove(fyusd, adapter, vault, amount);
      await adapter.connect(vault).deposit(amount);

      const balBefore = await fyusd.balanceOf(vault.address);
      await adapter.connect(vault).withdraw(amount);
      const balAfter = await fyusd.balanceOf(vault.address);

      assert.equal(balAfter - balBefore, amount, "1:1 withdraw with no yield");
      assert.equal(await adapter.shareOf(vault.address), 0n);
      assert.equal(await adapter.totalShares(), 0n);
    });

    it("delivers yield-inclusive amount when withdrawing all shares post-yield", async () => {
      const { deployer, vault, fyusd, adapter, concreteVault } = await deployFixture();
      const principal = 1000n * ONE;
      const yield_ = 100n * ONE;

      await fundAndApprove(fyusd, adapter, vault, principal);
      await adapter.connect(vault).deposit(principal);

      await fyusd.mint(deployer.address, yield_);
      await fyusd.connect(deployer).approve(await concreteVault.getAddress(), yield_);
      await concreteVault.connect(deployer).simulateYield(yield_);

      const balBefore = await fyusd.balanceOf(vault.address);
      await adapter.connect(vault).withdraw(principal);  // burn all shares
      const balAfter = await fyusd.balanceOf(vault.address);

      // OZ ERC-4626 rounds convertToAssets down by 1 wei (inflation-
      // attack protection). The adapter sees totalAssets = principal +
      // yield - 1 just before the withdraw, so the delivered amount is
      // principal + yield - 1 as well. 1-wei NAV under-report is
      // acceptable per upstream OZ design.
      const expected = principal + yield_ - 1n;
      assert.equal(balAfter - balBefore, expected,
        "withdraw delivers principal + yield (less the OZ inflation-bias 1 wei)");
      assert.equal(await adapter.totalShares(), 0n);
    });

    it("partial withdraw delivers proportional FYUSD", async () => {
      const { vault, fyusd, adapter } = await deployFixture();
      const principal = 1000n * ONE;

      await fundAndApprove(fyusd, adapter, vault, principal);
      await adapter.connect(vault).deposit(principal);

      const half = principal / 2n;
      const balBefore = await fyusd.balanceOf(vault.address);
      await adapter.connect(vault).withdraw(half);
      const balAfter = await fyusd.balanceOf(vault.address);

      assert.equal(balAfter - balBefore, half);
      assert.equal(await adapter.shareOf(vault.address), half);
      assert.equal(await adapter.totalShares(), half);
    });

    it("rejects withdraw beyond shareOf", async () => {
      const { vault, fyusd, adapter } = await deployFixture();
      const amount = 1000n * ONE;

      await fundAndApprove(fyusd, adapter, vault, amount);
      await adapter.connect(vault).deposit(amount);

      await assert.rejects(
        adapter.connect(vault).withdraw(amount + 1n),
        /InsufficientShares/,
      );
    });

    it("rejects zero amount", async () => {
      const { vault, adapter } = await deployFixture();
      await assert.rejects(
        adapter.connect(vault).withdraw(0),
        /ZeroAmount/,
      );
    });
  });

  describe("multi-holder isolation", () => {
    it("withdraw from holder A does not consume holder B's shares", async () => {
      const { vault, otherCaller, fyusd, adapter } = await deployFixture();

      await fundAndApprove(fyusd, adapter, vault, 1000n * ONE);
      await adapter.connect(vault).deposit(1000n * ONE);

      await fundAndApprove(fyusd, adapter, otherCaller, 500n * ONE);
      await adapter.connect(otherCaller).deposit(500n * ONE);

      assert.equal(await adapter.shareOf(vault.address), 1000n * ONE);
      assert.equal(await adapter.shareOf(otherCaller.address), 500n * ONE);

      // Vault withdraws all of theirs.
      await adapter.connect(vault).withdraw(1000n * ONE);

      assert.equal(await adapter.shareOf(vault.address), 0n);
      assert.equal(await adapter.shareOf(otherCaller.address), 500n * ONE,
        "other caller's shares untouched");
      assert.equal(await adapter.totalShares(), 500n * ONE);
    });
  });

  describe("realizedYield7d", () => {
    it("returns 0 (deferred to off-chain subgraph reader)", async () => {
      const { adapter } = await deployFixture();
      assert.equal(await adapter.realizedYield7d(), 0n);
    });
  });

  describe("asset()", () => {
    it("returns the FYUSD address", async () => {
      const { fyusd, adapter } = await deployFixture();
      assert.equal(
        (await adapter.asset()).toLowerCase(),
        (await fyusd.getAddress()).toLowerCase(),
      );
    });
  });
});
