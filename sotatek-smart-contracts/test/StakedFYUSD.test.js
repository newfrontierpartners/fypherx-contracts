/**
 * StakedFYUSD (sFYUSD) tests.
 *
 * Verifies:
 *   - 6 decimals; keeper-only mint (MINTER_ROLE) and burnByKeeper (BURNER_ROLE).
 *   - Lock-gate: while userUnlockAt[holder] is in the future, user→user
 *     transfers revert (TransferLocked); after it elapses, transfers succeed.
 *   - Mint (deposit) and burn (redeem) are EXEMPT from the lock — the keeper can
 *     always issue and redeem, even while the holder is locked.
 *   - setLock is LOCKER_ROLE-only and MONOTONIC (cannot shorten an existing lock).
 *   - setLockBatch seeds many holders (used by the migration).
 *   - pause() blocks all movement; only PAUSER_ROLE toggles it.
 *   - rescueTokens is admin-only.
 */
const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

const DAY = 86400;

async function warp(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine");
}

async function now() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp;
}

async function deploy() {
  const [admin, keeper, alice, bob, carol] = await ethers.getSigners();
  const SF = await ethers.getContractFactory("StakedFYUSD");
  const sf = await SF.deploy("Staked FYUSD", "sFYUSD", 6, admin.address);
  await sf.waitForDeployment();

  // Grant the keeper the operational roles (as the deploy script will).
  await sf.connect(admin).grantRole(await sf.MINTER_ROLE(), keeper.address);
  await sf.connect(admin).grantRole(await sf.BURNER_ROLE(), keeper.address);
  await sf.connect(admin).grantRole(await sf.LOCKER_ROLE(), keeper.address);
  await sf.connect(admin).grantRole(await sf.PAUSER_ROLE(), keeper.address);

  return { sf, admin, keeper, alice, bob, carol };
}

describe("StakedFYUSD", () => {
  it("has 6 decimals and the expected name/symbol", async () => {
    const { sf } = await deploy();
    assert.equal(await sf.decimals(), 6n);
    assert.equal(await sf.symbol(), "sFYUSD");
    assert.equal(await sf.name(), "Staked FYUSD");
  });

  it("only MINTER can mint and only BURNER can burnByKeeper", async () => {
    const { sf, keeper, alice } = await deploy();
    await sf.connect(keeper).mint(alice.address, 1_000_000n); // 1.0 sFYUSD (6-dec)
    assert.equal(await sf.balanceOf(alice.address), 1_000_000n);

    await assert.rejects(sf.connect(alice).mint(alice.address, 1n)); // no role
    await assert.rejects(sf.connect(alice).burnByKeeper(alice.address, 1n)); // no role

    await sf.connect(keeper).burnByKeeper(alice.address, 400_000n);
    assert.equal(await sf.balanceOf(alice.address), 600_000n);
  });

  it("blocks user transfers while locked, allows them once the lock elapses", async () => {
    const { sf, keeper, alice, bob } = await deploy();
    await sf.connect(keeper).mint(alice.address, 1_000_000n);

    const unlock = (await now()) + 60 * DAY;
    await sf.connect(keeper).setLock(alice.address, unlock);
    assert.equal(await sf.isTransferable(alice.address), false);

    // user → user transfer reverts while locked
    await assert.rejects(
      sf.connect(alice).transfer(bob.address, 100_000n),
      (e) => /TransferLocked/.test(String(e)),
    );

    // ...but the keeper can still mint to and burn from a locked holder
    await sf.connect(keeper).mint(alice.address, 500_000n); // deposit while locked
    await sf.connect(keeper).burnByKeeper(alice.address, 200_000n); // redeem while locked
    assert.equal(await sf.balanceOf(alice.address), 1_300_000n);

    // after the lock elapses, transfers succeed
    await warp(60 * DAY + 1);
    assert.equal(await sf.isTransferable(alice.address), true);
    await sf.connect(alice).transfer(bob.address, 300_000n);
    assert.equal(await sf.balanceOf(bob.address), 300_000n);
  });

  it("setLock is monotonic — cannot shorten an existing lock", async () => {
    const { sf, keeper, alice } = await deploy();
    const t = await now();
    await sf.connect(keeper).setLock(alice.address, t + 120 * DAY);
    // attempt to shorten → silently ignored (keeps the longer lock)
    await sf.connect(keeper).setLock(alice.address, t + 30 * DAY);
    const u = await sf.userUnlockAt(alice.address);
    assert.ok(u >= BigInt(t + 120 * DAY), "lock must not be shortened");
    // extending IS allowed
    await sf.connect(keeper).setLock(alice.address, t + 200 * DAY);
    assert.equal(await sf.userUnlockAt(alice.address), BigInt(t + 200 * DAY));
  });

  it("setLock / setLockBatch are LOCKER-only; batch seeds many holders", async () => {
    const { sf, keeper, alice, bob, carol } = await deploy();
    await assert.rejects(sf.connect(alice).setLock(alice.address, (await now()) + DAY));

    const t = await now();
    await sf.connect(keeper).setLockBatch(
      [alice.address, bob.address, carol.address],
      [t + 60 * DAY, t + 90 * DAY, t + 120 * DAY],
    );
    assert.equal(await sf.userUnlockAt(bob.address), BigInt(t + 90 * DAY));
    assert.equal(await sf.userUnlockAt(carol.address), BigInt(t + 120 * DAY));

    await assert.rejects(sf.connect(keeper).setLockBatch([alice.address], [1, 2]));
  });

  it("pause blocks all movement; only PAUSER can toggle", async () => {
    const { sf, admin, keeper, alice, bob } = await deploy();
    await sf.connect(keeper).mint(alice.address, 1_000_000n);

    await assert.rejects(sf.connect(alice).pause()); // no role
    await sf.connect(keeper).pause();
    await assert.rejects(sf.connect(alice).transfer(bob.address, 1n));
    await assert.rejects(sf.connect(keeper).mint(alice.address, 1n)); // paused blocks mint too

    await sf.connect(keeper).unpause();
    await sf.connect(alice).transfer(bob.address, 1n);
    assert.equal(await sf.balanceOf(bob.address), 1n);

    // admin also holds nothing special unless granted; DEFAULT_ADMIN can grant
    assert.equal(await sf.hasRole(await sf.DEFAULT_ADMIN_ROLE(), admin.address), true);
  });

  it("rescueTokens is admin-only", async () => {
    const { sf, admin, alice } = await deploy();
    const M = await ethers.getContractFactory("MockERC20");
    const m = await M.deploy("Mock", "MOK", 18);
    await m.waitForDeployment();
    await m.mint(await sf.getAddress(), 5n);

    await assert.rejects(sf.connect(alice).rescueTokens(await m.getAddress(), alice.address, 5n));
    await sf.connect(admin).rescueTokens(await m.getAddress(), admin.address, 5n);
    assert.equal(await m.balanceOf(admin.address), 5n);
  });
});
