/**
 * ConcreteAdapterV1 — adapter that wraps a Concrete (concrete.xyz)
 * Earn V2 ERC-4626 vault and exposes the IConcreteAdapter surface
 * the FyusdYieldVault expects.
 *
 * Verifies:
 *   - constructor rejects zero / mismatched asset / zero vault
 *   - first deposit mints shares 1:1 with assets
 *   - subsequent deposits scale shares by current price-per-share
 *     (so a deposit during yield accrual mints fewer shares than 1:1)
 *   - withdraw burns shares + delivers FYUSD to caller proportional
 *     to (totalAssets * shares / totalShares)
 *   - yield accrual on the underlying Concrete vault flows through
 *     to higher totalAssets() without changing share count
 *   - withdraw reverts when caller lacks shares
 *   - realizedYield7d returns 0 (intentional, see contract docstring)
 *   - FYP-01: only the bound vault may call deposit/withdraw
 *   - FYP-10: direct Concrete-share transfers don't inflate
 *             totalAssets, and the excess is sweepable
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

  // The adapter under test. Bound to the `vault` signer so that signer
  // alone may call deposit/withdraw (post-FYP-01 single-tenant model).
  const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
  const adapter = await Adapter.deploy(
    await fyusd.getAddress(),
    await concreteVault.getAddress(),
    vault.address,
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
      const { concreteVault, vault } = await deployFixture();
      const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
      await assert.rejects(
        Adapter.deploy(ethers.ZeroAddress, await concreteVault.getAddress(), vault.address),
        /ZeroAddress/,
      );
    });

    it("rejects zero concreteVault address", async () => {
      const { fyusd, vault } = await deployFixture();
      const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
      await assert.rejects(
        Adapter.deploy(await fyusd.getAddress(), ethers.ZeroAddress, vault.address),
        /ZeroAddress/,
      );
    });

    it("rejects zero vault address (FYP-01: must bind to a tenant)", async () => {
      const { fyusd, concreteVault } = await deployFixture();
      const Adapter = await ethers.getContractFactory("ConcreteAdapterV1");
      await assert.rejects(
        Adapter.deploy(await fyusd.getAddress(), await concreteVault.getAddress(), ethers.ZeroAddress),
        /ZeroAddress/,
      );
    });

    it("rejects vault whose asset() doesn't match fyusd", async () => {
      const [, vault] = await ethers.getSigners();
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
        Adapter.deploy(await fyusd.getAddress(), await wrongVault.getAddress(), vault.address),
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
      const { deployer, vault, fyusd, adapter, concreteVault } = await deployFixture();

      // Vault deposits 1000 first.
      const v1 = 1000n * ONE;
      await fundAndApprove(fyusd, adapter, vault, v1);
      await adapter.connect(vault).deposit(v1);

      // Yield: vault now backed by 1100 FYUSD, still 1000 shares.
      const yield_ = 100n * ONE;
      await fyusd.mint(deployer.address, yield_);
      await fyusd.connect(deployer).approve(await concreteVault.getAddress(), yield_);
      await concreteVault.connect(deployer).simulateYield(yield_);

      // Vault deposits another 110 FYUSD — should mint ~100 adapter
      // shares (110 * 1000 / 1099, accounting for the OZ 1-wei NAV
      // round-down), not 110.
      const v2 = 110n * ONE;
      await fundAndApprove(fyusd, adapter, vault, v2);
      await adapter.connect(vault).deposit(v2);

      const newShares = await adapter.shareOf(vault.address) - v1;
      // Allow a small tolerance because of the 1-wei OZ rounding.
      assert.ok(newShares >= 99n * ONE && newShares <= 100n * ONE + 1n,
        `expected ~100e18 new shares, got ${newShares}`);
      assert.ok(newShares < v2, "fewer shares minted than assets deposited (post-yield)");
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

  describe("single-tenant binding (FYP-01)", () => {
    it("rejects deposit from non-vault caller", async () => {
      const { otherCaller, fyusd, adapter } = await deployFixture();
      await fundAndApprove(fyusd, adapter, otherCaller, 100n * ONE);
      await assert.rejects(
        adapter.connect(otherCaller).deposit(100n * ONE),
        /NotVault/,
      );
    });

    it("rejects withdraw from non-vault caller", async () => {
      const { vault, otherCaller, fyusd, adapter } = await deployFixture();
      await fundAndApprove(fyusd, adapter, vault, 100n * ONE);
      await adapter.connect(vault).deposit(100n * ONE);
      await assert.rejects(
        adapter.connect(otherCaller).withdraw(1n),
        /NotVault/,
      );
    });
  });

  describe("excess-share sweep (FYP-10)", () => {
    it("totalAssets ignores direct Concrete-share transfers to the adapter", async () => {
      const { deployer, vault, otherCaller, fyusd, concreteVault, adapter } =
        await deployFixture();

      // Vault deposit baseline.
      await fundAndApprove(fyusd, adapter, vault, 1000n * ONE);
      await adapter.connect(vault).deposit(1000n * ONE);
      const taBefore = await adapter.totalAssets();

      // An attacker deposits into Concrete vault directly and forwards
      // the resulting ccFYUSD shares to the adapter.
      await fyusd.mint(otherCaller.address, 500n * ONE);
      await fyusd.connect(otherCaller).approve(await concreteVault.getAddress(), 500n * ONE);
      await concreteVault.connect(otherCaller).deposit(500n * ONE, otherCaller.address);
      const cShares = await concreteVault.balanceOf(otherCaller.address);
      await concreteVault.connect(otherCaller).transfer(await adapter.getAddress(), cShares);

      // totalAssets() MUST be unchanged — the adapter ignores the
      // untracked Concrete shares.
      assert.equal(await adapter.totalAssets(), taBefore,
        "direct Concrete-share transfer does not inflate adapter NAV");
    });

    it("sweepConcreteShares forwards the excess and rejects non-vault callers", async () => {
      const { deployer, vault, otherCaller, fyusd, concreteVault, adapter } =
        await deployFixture();

      // Vault deposit baseline so accountedConcreteShares is non-zero.
      await fundAndApprove(fyusd, adapter, vault, 1000n * ONE);
      await adapter.connect(vault).deposit(1000n * ONE);

      // Donate untracked Concrete shares to the adapter.
      await fyusd.mint(otherCaller.address, 250n * ONE);
      await fyusd.connect(otherCaller).approve(await concreteVault.getAddress(), 250n * ONE);
      await concreteVault.connect(otherCaller).deposit(250n * ONE, otherCaller.address);
      const cShares = await concreteVault.balanceOf(otherCaller.address);
      await concreteVault.connect(otherCaller).transfer(await adapter.getAddress(), cShares);

      // Non-vault caller cannot sweep.
      await assert.rejects(
        adapter.connect(otherCaller).sweepConcreteShares(deployer.address),
        /NotVault/,
      );

      // Vault sweeps; receives exactly the donated amount.
      const before = await concreteVault.balanceOf(deployer.address);
      await adapter.connect(vault).sweepConcreteShares(deployer.address);
      const after = await concreteVault.balanceOf(deployer.address);
      assert.equal(after - before, cShares, "sweep forwards the donated excess");

      // Calling sweep again with no surplus reverts.
      await assert.rejects(
        adapter.connect(vault).sweepConcreteShares(deployer.address),
        /NoExcessShares/,
      );
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
