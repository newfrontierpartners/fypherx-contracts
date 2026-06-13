/**
 * FyusdEarnVault (blended vFYUSD) — the 70:30 Earn vault, PRODUCT-FLOWS C-4.
 *
 * A thin, ratio-agnostic, keeper-orchestrated vault. vFYUSD represents a
 * blended position: on-chain Concrete leg (via ConcreteStableAdapter) +
 * off-chain BitGo-custody leg (keeper-reported NAV).
 *
 * Verifies:
 *   - keeper-only depositBlended mints vFYUSD for (concrete + offChain),
 *     routes the concrete leg to Concrete and books the off-chain leg
 *   - totalAssets() = adapter.totalAssets() + offChainBackedAssets
 *   - standard ERC-4626 deposit/mint/withdraw/redeem are disabled
 *   - accrueOffChainYield raises NAV; adminAdjustOffChainAssets corrects it
 *   - requestRedeem splits pool-proportionally: on-chain → 14d silo
 *     cooldown, off-chain → offChainOwed (BitGo wire)
 *   - unstake releases the matured on-chain leg; settleOffChainClaim clears
 *     the off-chain record
 *   - access control (onlyKeeper / onlyAdmin) + pause
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const USDC = 10n ** 6n;
const FOURTEEN_DAYS = 14n * 24n * 60n * 60n;

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

async function deployFixture() {
  const [deployer, keeper, alice, bob, pauser, stranger] = await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });
  await (await setting.setPoolConfigs("vFyusdEarnCooldown", FOURTEEN_DAYS)).wait();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdc = await Mock.deploy("Mock USDC", "USDC", 6);

  const ConcreteVault = await ethers.getContractFactory("MockERC4626Vault");
  const concreteVault = await ConcreteVault.deploy(
    await usdc.getAddress(), "Concrete USDC Vault", "ccUSDC",
  );

  // Deploy the vault proxy UNINITIALIZED so we can bind the adapter to its
  // address (the adapter's vault binding is immutable) before initialize.
  const Vault = await ethers.getContractFactory("FyusdEarnVault");
  const vault = await upgrades.deployProxy(Vault, [], { initializer: false, kind: "transparent" });
  const vaultAddr = await vault.getAddress();

  const Adapter = await ethers.getContractFactory("ConcreteStableAdapter");
  const adapter = await Adapter.deploy(
    await usdc.getAddress(), await concreteVault.getAddress(), vaultAddr,
  );

  await (await vault.initialize(
    await setting.getAddress(),
    await usdc.getAddress(),
    await adapter.getAddress(),
    deployer.address,
  )).wait();

  await (await vault.setKeeper(keeper.address)).wait();
  await (await vault.setPauserRole(pauser.address)).wait();

  // Fund the keeper with USDC for the on-chain leg + approve the vault.
  await (await usdc.mint(keeper.address, 10_000_000n * USDC)).wait();
  await (await usdc.connect(keeper).approve(vaultAddr, ethers.MaxUint256)).wait();

  return { deployer, keeper, alice, bob, pauser, stranger, setting, usdc, concreteVault, adapter, vault };
}

// Keeper-side helper: split `total` into legs by `fyusdBps` and deposit.
async function depositFor(vault, keeper, receiver, total, fyusdBps = 7000n) {
  const offChain = (total * fyusdBps) / 10000n; // 70% off-chain (BitGo FYUSD)
  const concrete = total - offChain;            // 30% on-chain (Concrete USDC)
  await (await vault.connect(keeper).depositBlended(receiver.address, concrete, offChain)).wait();
  return { concrete, offChain };
}

describe("FyusdEarnVault (blended vFYUSD)", () => {
  describe("initialize / metadata", () => {
    it("sets blended metadata + 14d default cooldown", async () => {
      const { vault } = await deployFixture();
      assert.equal(await vault.name(), "Earn FYUSD");
      assert.equal(await vault.symbol(), "vFYUSD");
      assert.equal(await vault.decimals(), 6n); // matches USDC
      assert.equal(await vault.currentCooldownDuration(), FOURTEEN_DAYS);
    });
  });

  describe("depositBlended (keeper, ratio-agnostic)", () => {
    it("mints vFYUSD for the total + routes both legs", async () => {
      const { keeper, alice, usdc, adapter, vault } = await deployFixture();
      const { concrete, offChain } = await depositFor(vault, keeper, alice, 1000n * USDC);

      assert.equal(await vault.balanceOf(alice.address), 1000n * USDC, "1:1 first mint");
      assert.equal(await vault.totalSupply(), 1000n * USDC);
      assert.equal(await adapter.totalAssets(), concrete, "30% leg in Concrete");
      assert.equal(await vault.offChainBackedAssets(), offChain, "70% leg booked off-chain");
      assert.equal(await vault.totalAssets(), 1000n * USDC, "blended NAV = both legs");
      // Vault holds no idle USDC — concrete leg forwarded to the adapter.
      assert.equal(await usdc.balanceOf(await vault.getAddress()), 0n);
    });

    it("accepts a pure off-chain deposit (concrete leg = 0)", async () => {
      const { keeper, alice, adapter, vault } = await deployFixture();
      await (await vault.connect(keeper).depositBlended(alice.address, 0n, 1000n * USDC)).wait();
      assert.equal(await adapter.totalAssets(), 0n);
      assert.equal(await vault.offChainBackedAssets(), 1000n * USDC);
      assert.equal(await vault.balanceOf(alice.address), 1000n * USDC);
    });

    it("accepts a pure on-chain deposit (off-chain leg = 0)", async () => {
      const { keeper, alice, adapter, vault } = await deployFixture();
      await (await vault.connect(keeper).depositBlended(alice.address, 1000n * USDC, 0n)).wait();
      assert.equal(await adapter.totalAssets(), 1000n * USDC);
      assert.equal(await vault.offChainBackedAssets(), 0n);
    });

    it("a second deposit after off-chain yield mints fewer shares", async () => {
      const { keeper, alice, bob, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);

      // 10% off-chain yield → NAV 1100, supply still 1000.
      await (await vault.connect(keeper).accrueOffChainYield(100n * USDC)).wait();

      const supplyBefore = await vault.totalSupply();
      await depositFor(vault, keeper, bob, 1100n * USDC);
      const minted = (await vault.totalSupply()) - supplyBefore;
      assert.ok(minted < 1100n * USDC, "post-yield deposit mints fewer shares than assets");
      assert.ok(minted >= 999n * USDC && minted <= 1000n * USDC, `expected ~1000e6, got ${minted}`);
    });

    it("rejects non-keeper callers", async () => {
      const { alice, stranger, vault } = await deployFixture();
      await assert.rejects(
        vault.connect(stranger).depositBlended(alice.address, 10n * USDC, 20n * USDC),
        /NotKeeper/,
      );
    });

    it("rejects zero total + zero receiver", async () => {
      const { keeper, alice, vault } = await deployFixture();
      await assert.rejects(vault.connect(keeper).depositBlended(alice.address, 0n, 0n), /ZeroAmount/);
      await assert.rejects(
        vault.connect(keeper).depositBlended(ethers.ZeroAddress, 10n * USDC, 0n),
        /ZeroAddress/,
      );
    });
  });

  describe("disabled ERC-4626 entry points", () => {
    it("deposit / mint revert with UseDepositBlended", async () => {
      const { alice, vault } = await deployFixture();
      await assert.rejects(vault.connect(alice).deposit(1n, alice.address), /UseDepositBlended/);
      await assert.rejects(vault.connect(alice).mint(1n, alice.address), /UseDepositBlended/);
    });

    it("withdraw / redeem are blocked (max* = 0 gates them before _withdraw)", async () => {
      const { keeper, alice, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);
      // OZ checks maxWithdraw/maxRedeem (both 0 here) before reaching the
      // _withdraw override, so the synchronous exit is disabled with the
      // standard ExceededMax error. Either way, no synchronous exit exists.
      await assert.rejects(
        vault.connect(alice).withdraw(1n, alice.address, alice.address),
        /ERC4626ExceededMaxWithdraw/,
      );
      await assert.rejects(
        vault.connect(alice).redeem(1n, alice.address, alice.address),
        /ERC4626ExceededMaxRedeem/,
      );
    });

    it("max* / preview* return 0", async () => {
      const { alice, vault } = await deployFixture();
      assert.equal(await vault.maxDeposit(alice.address), 0n);
      assert.equal(await vault.maxRedeem(alice.address), 0n);
      assert.equal(await vault.previewRedeem(1n), 0n);
    });
  });

  describe("off-chain NAV reporting", () => {
    it("accrueOffChainYield raises NAV (keeper-only)", async () => {
      const { keeper, alice, stranger, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);
      const navBefore = await vault.totalAssets();
      await (await vault.connect(keeper).accrueOffChainYield(50n * USDC)).wait();
      assert.equal(await vault.totalAssets(), navBefore + 50n * USDC);
      await assert.rejects(vault.connect(stranger).accrueOffChainYield(1n), /NotKeeper/);
    });

    it("adminAdjustOffChainAssets corrects NAV up + down (admin-only)", async () => {
      const { deployer, keeper, alice, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC); // offChain = 700
      await (await vault.connect(deployer).adminAdjustOffChainAssets(-100n * USDC, ethers.ZeroHash)).wait();
      assert.equal(await vault.offChainBackedAssets(), 600n * USDC);
      await (await vault.connect(deployer).adminAdjustOffChainAssets(25n * USDC, ethers.ZeroHash)).wait();
      assert.equal(await vault.offChainBackedAssets(), 625n * USDC);
      await assert.rejects(
        vault.connect(keeper).adminAdjustOffChainAssets(1n, ethers.ZeroHash),
        /NotAdmin/,
      );
    });

    it("adminAdjustOffChainAssets rejects underflow", async () => {
      const { deployer, keeper, alice, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC); // offChain = 700
      await assert.rejects(
        vault.connect(deployer).adminAdjustOffChainAssets(-701n * USDC, ethers.ZeroHash),
        /OffChainAssetsUnderflow/,
      );
    });
  });

  describe("requestRedeem (2-tranche split)", () => {
    it("splits pool-proportionally: on-chain → silo, off-chain → owed", async () => {
      const { keeper, alice, adapter, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC); // 300 concrete / 700 offChain

      const [onChain, offChain] = await vault.connect(alice).requestRedeem.staticCall(400n * USDC);
      assert.equal(onChain, 120n * USDC, "400 * 300/1000");
      assert.equal(offChain, 280n * USDC, "400 * 700/1000");

      await (await vault.connect(alice).requestRedeem(400n * USDC)).wait();

      assert.equal(await vault.balanceOf(alice.address), 600n * USDC, "shares burned");
      assert.equal(await vault.totalSupply(), 600n * USDC);
      // On-chain leg moved into the silo cooldown.
      const [cooldownEnd, underlying] = await vault.cooldowns(alice.address);
      assert.equal(underlying, 120n * USDC);
      assert.ok(cooldownEnd > 0n);
      // Off-chain leg recorded as owed + removed from NAV.
      assert.equal(await vault.offChainOwed(alice.address), 280n * USDC);
      assert.equal(await vault.totalOffChainOwed(), 280n * USDC);
      assert.equal(await vault.offChainBackedAssets(), 420n * USDC);
      assert.equal(await adapter.totalAssets(), 180n * USDC, "concrete leg drained by 120");
    });

    it("preserves share price for remaining holders", async () => {
      const { keeper, alice, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);
      const priceBefore = await vault.convertToAssets(USDC);
      await (await vault.connect(alice).requestRedeem(400n * USDC)).wait();
      const priceAfter = await vault.convertToAssets(USDC);
      assert.equal(priceAfter, priceBefore, "redemption is NAV-neutral");
    });

    it("rejects redeeming more than balance + zero", async () => {
      const { keeper, alice, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);
      await assert.rejects(vault.connect(alice).requestRedeem(0n), /ZeroAmount/);
      await assert.rejects(vault.connect(alice).requestRedeem(1001n * USDC), /InsufficientShares/);
    });
  });

  describe("unstake (on-chain leg)", () => {
    it("releases the on-chain leg only after the 14-day cooldown", async () => {
      const { keeper, alice, usdc, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);
      await (await vault.connect(alice).requestRedeem(400n * USDC)).wait();

      await assert.rejects(vault.connect(alice).unstake(alice.address), /CooldownNotFinished/);

      await increaseTime(FOURTEEN_DAYS + 1n);
      const before = await usdc.balanceOf(alice.address);
      await (await vault.connect(alice).unstake(alice.address)).wait();
      const after = await usdc.balanceOf(alice.address);
      assert.equal(after - before, 120n * USDC, "on-chain leg released from silo");

      const [, underlying] = await vault.cooldowns(alice.address);
      assert.equal(underlying, 0n, "cooldown cleared");
    });

    it("reverts unstake when no cooldown started", async () => {
      const { alice, vault } = await deployFixture();
      await assert.rejects(vault.connect(alice).unstake(alice.address), /NoCooldownStarted/);
    });
  });

  describe("settleOffChainClaim (keeper)", () => {
    it("clears the off-chain owed record on confirmed BitGo wire", async () => {
      const { keeper, alice, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);
      await (await vault.connect(alice).requestRedeem(400n * USDC)).wait();
      assert.equal(await vault.offChainOwed(alice.address), 280n * USDC);

      const txRef = ethers.keccak256(ethers.toUtf8Bytes("bitgo-order-123"));
      await (await vault.connect(keeper).settleOffChainClaim(alice.address, 280n * USDC, txRef)).wait();
      assert.equal(await vault.offChainOwed(alice.address), 0n);
      assert.equal(await vault.totalOffChainOwed(), 0n);
    });

    it("rejects over-settling + non-keeper", async () => {
      const { keeper, alice, stranger, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);
      await (await vault.connect(alice).requestRedeem(400n * USDC)).wait();
      await assert.rejects(
        vault.connect(keeper).settleOffChainClaim(alice.address, 281n * USDC, ethers.ZeroHash),
        /OffChainClaimOverflow/,
      );
      await assert.rejects(
        vault.connect(stranger).settleOffChainClaim(alice.address, 1n, ethers.ZeroHash),
        /NotKeeper/,
      );
    });
  });

  describe("admin / pause", () => {
    it("pause blocks deposit + redeem; only admin unpauses", async () => {
      const { deployer, keeper, alice, pauser, vault } = await deployFixture();
      await depositFor(vault, keeper, alice, 1000n * USDC);

      await (await vault.connect(pauser).pause()).wait();
      await assert.rejects(
        vault.connect(keeper).depositBlended(alice.address, 1n, 1n),
        /EnforcedPause/,
      );
      await assert.rejects(vault.connect(alice).requestRedeem(1n * USDC), /EnforcedPause/);
      await assert.rejects(vault.connect(pauser).unpause(), /NotAdmin/);

      await (await vault.connect(deployer).unpause()).wait();
      await (await vault.connect(alice).requestRedeem(1n * USDC)).wait();
    });

    it("setKeeper / setPauserRole are admin-only + reject zero", async () => {
      const { deployer, alice, stranger, vault } = await deployFixture();
      await assert.rejects(vault.connect(stranger).setKeeper(alice.address), /NotAdmin/);
      await assert.rejects(vault.connect(deployer).setKeeper(ethers.ZeroAddress), /ZeroAddress/);
      await (await vault.connect(deployer).setKeeper(alice.address)).wait();
      assert.equal(await vault.keeper(), alice.address);
    });

    it("rescueTokens cannot rescue the underlying USDC", async () => {
      const { deployer, vault } = await deployFixture();
      await assert.rejects(
        vault.connect(deployer).rescueTokens(await vault.asset(), deployer.address, 1n),
        /Cannot rescue staked asset/,
      );
    });
  });
});
