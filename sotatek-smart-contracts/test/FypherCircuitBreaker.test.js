/**
 * FypherCircuitBreaker — multicall trip/reset orchestrator.
 *
 * End-to-end: register a trigger that pauses two contracts at once
 * (FypherMinting + FyusdYieldVault), have the watchdog trip it, verify
 * both contracts are now paused, then admin reset and verify both
 * unpaused. Uses the real on-chain pauserRole wiring (breaker IS the
 * pauser on each target).
 */
const assert = require("node:assert/strict");
const { ethers, upgrades } = require("hardhat");

const ONE = 10n ** 18n;

async function deployFixture() {
  const [deployer, watchdog, nonAdmin] = await ethers.getSigners();

  const SettingManagement = await ethers.getContractFactory("SettingManagement");
  const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const RUSD = await ethers.getContractFactory("RUSD");
  const rusd = await upgrades.deployProxy(RUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const FYUSD = await ethers.getContractFactory("FYUSD");
  const fyusd = await upgrades.deployProxy(FYUSD, [deployer.address], {
    initializer: "initialize", kind: "transparent",
  });

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdt = await MockERC20.deploy("Mock USDT", "mUSDT", 18);

  // FypherMinting (target 1).
  const Minting = await ethers.getContractFactory("FypherMinting");
  const minting = await upgrades.deployProxy(Minting, [
    await setting.getAddress(),
    await rusd.getAddress(),
    deployer.address, // backendSigner
    deployer.address, // backendExecutor
  ], { initializer: "initialize", kind: "transparent" });
  await (await rusd.setMinter(await minting.getAddress())).wait();
  await (await minting.addSupportedAsset(await usdt.getAddress())).wait();

  // FyusdYieldVault (target 2).
  const MockAdapter = await ethers.getContractFactory("MockConcreteAdapter");
  // vault=0 keeps the mock in legacy free-for-all mode; the breaker
  // test doesn't exercise the single-tenant FYP-01 path.
  const adapter = await MockAdapter.deploy(await fyusd.getAddress(), 0n, ethers.ZeroAddress);
  const Vault = await ethers.getContractFactory("FyusdYieldVault");
  const vault = await upgrades.deployProxy(Vault, [
    await setting.getAddress(),
    await fyusd.getAddress(),
    await adapter.getAddress(),
    deployer.address,
  ], { initializer: "initialize", kind: "transparent" });

  // Breaker.
  const Breaker = await ethers.getContractFactory("FypherCircuitBreaker");
  const breaker = await upgrades.deployProxy(Breaker, [
    await setting.getAddress(),
    watchdog.address,
  ], { initializer: "initialize", kind: "transparent" });

  // Wire breaker as pauser on both targets so trip() can pause.
  // (Unpause is admin-only on the targets and stays with the multisig —
  //  the breaker.reset() call is audit-only, see contract docs.)
  await (await minting.setPauserRole(await breaker.getAddress())).wait();
  await (await vault.setPauserRole(await breaker.getAddress())).wait();

  return { deployer, watchdog, nonAdmin, setting, minting, vault, breaker, usdt };
}

function encodeSetMintPaused(asset, paused) {
  return new ethers.Interface([
    "function setMintPaused(address,bool)",
  ]).encodeFunctionData("setMintPaused", [asset, paused]);
}

function encodeVaultPause() {
  return new ethers.Interface(["function pause()"]).encodeFunctionData("pause", []);
}

function encodeVaultUnpause() {
  return new ethers.Interface(["function unpause()"]).encodeFunctionData("unpause", []);
}

describe("FypherCircuitBreaker", () => {
  describe("registerTrigger", () => {
    it("admin can register; non-admin cannot; assigns sequential triggerIds", async () => {
      const { breaker, minting, usdt, nonAdmin } = await deployFixture();
      const pauseCall = {
        target: await minting.getAddress(),
        data: encodeSetMintPaused(await usdt.getAddress(), true),
      };
      const unpauseCall = {
        target: await minting.getAddress(),
        data: encodeSetMintPaused(await usdt.getAddress(), false),
      };

      // Non-admin rejected.
      await assert.rejects(
        breaker.connect(nonAdmin).registerTrigger(
          "ETH oracle deviation", "...", [pauseCall], [unpauseCall],
        ),
        (err) => err.message.includes("NotAdmin"),
      );

      // Admin OK.
      const tx = await breaker.registerTrigger(
        "USDT mint pause", "Test trigger", [pauseCall], [unpauseCall],
      );
      await tx.wait();
      assert.equal(await breaker.triggersLength(), 1n);
      const info = await breaker.triggerInfo(0n);
      assert.equal(info.name, "USDT mint pause");
      assert.equal(info.pauseCallCount, 1n);
      assert.equal(info.tripped, false);
    });

    it("rejects EmptyTrigger and ZeroAddress targets", async () => {
      const { breaker, minting, usdt } = await deployFixture();
      await assert.rejects(
        breaker.registerTrigger("name", "desc", [], []),
        (err) => err.message.includes("EmptyTrigger"),
      );
      await assert.rejects(
        breaker.registerTrigger("name", "desc",
          [{ target: ethers.ZeroAddress, data: "0x" }],
          [],
        ),
        (err) => err.message.includes("ZeroAddress"),
      );
    });
  });

  describe("trip + reset (end to end)", () => {
    it("watchdog trips a multi-target trigger; both contracts get paused", async () => {
      const { breaker, minting, vault, usdt, watchdog } = await deployFixture();
      // Register a trigger that pauses BOTH minting (USDT-asset) and vault.
      const pauseCalls = [
        { target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), true) },
        { target: await vault.getAddress(),   data: encodeVaultPause() },
      ];
      const unpauseCalls = [
        { target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), false) },
        { target: await vault.getAddress(),   data: encodeVaultUnpause() },
      ];
      await (await breaker.registerTrigger("major incident", "...", pauseCalls, unpauseCalls)).wait();

      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("incident-001"));
      await (await breaker.connect(watchdog).trip(0n, reasonHash)).wait();

      assert.equal(await minting.mintPaused(await usdt.getAddress()), true);
      assert.equal(await vault.paused(), true);
      assert.equal((await breaker.triggerInfo(0n)).tripped, true);
    });

    it("admin reset clears the trigger flag (audit-only — actual unpause is multisig-direct)", async () => {
      const { deployer, breaker, minting, vault, usdt, watchdog } = await deployFixture();
      const pauseCalls = [
        { target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), true) },
        { target: await vault.getAddress(),   data: encodeVaultPause() },
      ];
      const unpauseCalls = [
        { target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), false) },
        { target: await vault.getAddress(),   data: encodeVaultUnpause() },
      ];
      await (await breaker.registerTrigger("major incident", "...", pauseCalls, unpauseCalls)).wait();
      await (await breaker.connect(watchdog).trip(0n, ethers.ZeroHash)).wait();

      // Watchdog cannot reset.
      await assert.rejects(
        breaker.connect(watchdog).reset(0n, ethers.ZeroHash),
        (err) => err.message.includes("NotAdmin"),
      );

      // Targets are still paused (reset doesn't unpause; multisig must call target directly).
      await (await breaker.connect(deployer).reset(0n, ethers.ZeroHash)).wait();
      assert.equal((await breaker.triggerInfo(0n)).tripped, false);
      // Targets remain paused — multisig still has work to do.
      assert.equal(await minting.mintPaused(await usdt.getAddress()), true);
      assert.equal(await vault.paused(), true);

      // Multisig (deployer in tests) issues the actual unpause txs.
      await (await minting.connect(deployer).setMintPaused(await usdt.getAddress(), false)).wait();
      await (await vault.connect(deployer).unpause()).wait();
      assert.equal(await minting.mintPaused(await usdt.getAddress()), false);
      assert.equal(await vault.paused(), false);

      // The unpauseCalls template stored on the breaker matches what the
      // multisig just executed — operator can read it for the next incident.
      const [t0, d0] = await breaker.unpauseCallAt(0n, 0n);
      assert.equal(t0, await minting.getAddress());
      assert.equal(d0, encodeSetMintPaused(await usdt.getAddress(), false));
    });

    it("trip + reset are idempotent (AlreadyTripped / NotTripped guards)", async () => {
      const { breaker, minting, usdt, watchdog } = await deployFixture();
      const pauseCalls = [{ target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), true) }];
      const unpauseCalls = [{ target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), false) }];
      await (await breaker.registerTrigger("t", "...", pauseCalls, unpauseCalls)).wait();
      await (await breaker.connect(watchdog).trip(0n, ethers.ZeroHash)).wait();
      await assert.rejects(
        breaker.connect(watchdog).trip(0n, ethers.ZeroHash),
        (err) => err.message.includes("AlreadyTripped"),
      );
      await (await breaker.reset(0n, ethers.ZeroHash)).wait();
      await assert.rejects(
        breaker.reset(0n, ethers.ZeroHash),
        (err) => err.message.includes("NotTripped"),
      );
    });

    it("reverts SubcallReverted if breaker is not the pauser on a target", async () => {
      const { deployer, breaker, minting, usdt, watchdog } = await deployFixture();
      // Demote breaker as pauser on minting → its setMintPaused call will revert NotPauserOrAdmin.
      await (await minting.setPauserRole(deployer.address)).wait();

      const pauseCalls = [{ target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), true) }];
      const unpauseCalls = [{ target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), false) }];
      await (await breaker.registerTrigger("t", "...", pauseCalls, unpauseCalls)).wait();

      await assert.rejects(
        breaker.connect(watchdog).trip(0n, ethers.ZeroHash),
        (err) => err.message.includes("SubcallReverted"),
      );
    });
  });

  describe("watchdog admin", () => {
    it("setWatchdog is admin-only and rotates the trip authority", async () => {
      const { breaker, watchdog, nonAdmin, minting, usdt } = await deployFixture();
      const pauseCalls = [{ target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), true) }];
      const unpauseCalls = [{ target: await minting.getAddress(), data: encodeSetMintPaused(await usdt.getAddress(), false) }];
      await (await breaker.registerTrigger("t", "...", pauseCalls, unpauseCalls)).wait();

      await assert.rejects(
        breaker.connect(nonAdmin).setWatchdog(nonAdmin.address),
        (err) => err.message.includes("NotAdmin"),
      );
      await (await breaker.setWatchdog(nonAdmin.address)).wait();
      // Old watchdog can no longer trip.
      await assert.rejects(
        breaker.connect(watchdog).trip(0n, ethers.ZeroHash),
        (err) => err.message.includes("NotWatchdogOrAdmin"),
      );
      // New watchdog can.
      await (await breaker.connect(nonAdmin).trip(0n, ethers.ZeroHash)).wait();
    });
  });
});
