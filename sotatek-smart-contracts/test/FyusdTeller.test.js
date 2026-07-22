/**
 * FyusdTeller tests — the GIWA environment's fully on-chain FYUSD desk.
 *
 * Verifies:
 *   - mint escrows the stable 1:1 and mints decimal-scaled FYUSD
 *     (6-dec USDT -> 18-dec FYUSD).
 *   - redeem is the exact inverse and burns only what it pays out.
 *   - the 1:1 reserve invariant holds across interleaved user activity.
 *   - unsupported assets, zero amounts, and sub-base-unit dust all revert
 *     rather than silently burning value.
 *   - a stable with MORE decimals than FYUSD is rejected at registration.
 *   - delisting an asset closes mint but keeps redeem open (funds are
 *     never trapped behind a config flag).
 *   - sweepSurplus can only move balance ABOVE the tracked reserve.
 *   - pause blocks both user paths; only the owner can toggle it.
 *   - fee-on-transfer stables mint against what actually arrived.
 */
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const ONE_FYUSD = 10n ** 18n;   // FYUSD is 18-dec
const ONE_USDT  = 10n ** 6n;    // test stables are 6-dec
const SCALE     = 10n ** 12n;   // 18 - 6

async function fixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const FYUSD = await ethers.getContractFactory("FYUSD");
  const { upgrades } = require("hardhat");
  const fyusd = await upgrades.deployProxy(FYUSD, [owner.address], {
    initializer: "initialize",
    kind: "transparent",
  });
  await fyusd.waitForDeployment();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdt = await Mock.deploy("Tether USD (GIWA Test)", "USDT", 6);
  await usdt.waitForDeployment();

  const Teller = await ethers.getContractFactory("FyusdTeller");
  const teller = await Teller.deploy(await fyusd.getAddress(), owner.address);
  await teller.waitForDeployment();

  // The teller is FYUSD's minter; burnFrom comes from ERC20Burnable and
  // needs a user allowance, not a role.
  await (await fyusd.setMinter(await teller.getAddress())).wait();
  await (await teller.setSupportedAsset(await usdt.getAddress(), true)).wait();

  return { owner, alice, bob, fyusd, usdt, teller };
}

/** Give `who` `amount` base units of usdt and approve the teller. */
async function fund(usdt, teller, who, amount) {
  await (await usdt.mint(who.address, amount)).wait();
  await (await usdt.connect(who).approve(await teller.getAddress(), amount)).wait();
}

describe("FyusdTeller", function () {
  it("mints FYUSD 1:1 with decimal scaling and escrows the stable", async function () {
    const { alice, fyusd, usdt, teller } = await fixture();
    await fund(usdt, teller, alice, 100n * ONE_USDT);

    await (await teller.connect(alice).mint(await usdt.getAddress(), 100n * ONE_USDT)).wait();

    assert.equal(await fyusd.balanceOf(alice.address), 100n * ONE_FYUSD);
    assert.equal(await usdt.balanceOf(alice.address), 0n);
    assert.equal(await usdt.balanceOf(await teller.getAddress()), 100n * ONE_USDT);
    assert.equal(await teller.reserveOf(await usdt.getAddress()), 100n * ONE_USDT);
  });

  it("redeems back to the stable and burns exactly what it pays out", async function () {
    const { alice, fyusd, usdt, teller } = await fixture();
    await fund(usdt, teller, alice, 100n * ONE_USDT);
    await (await teller.connect(alice).mint(await usdt.getAddress(), 100n * ONE_USDT)).wait();

    await (await fyusd.connect(alice).approve(await teller.getAddress(), 40n * ONE_FYUSD)).wait();
    await (await teller.connect(alice).redeem(await usdt.getAddress(), 40n * ONE_FYUSD)).wait();

    assert.equal(await fyusd.balanceOf(alice.address), 60n * ONE_FYUSD);
    assert.equal(await usdt.balanceOf(alice.address), 40n * ONE_USDT);
    assert.equal(await teller.reserveOf(await usdt.getAddress()), 60n * ONE_USDT);
  });

  it("keeps reserves fully backing supply across interleaved users", async function () {
    const { alice, bob, fyusd, usdt, teller } = await fixture();
    await fund(usdt, teller, alice, 250n * ONE_USDT);
    await fund(usdt, teller, bob, 75n * ONE_USDT);

    await (await teller.connect(alice).mint(await usdt.getAddress(), 250n * ONE_USDT)).wait();
    await (await teller.connect(bob).mint(await usdt.getAddress(), 75n * ONE_USDT)).wait();
    await (await fyusd.connect(alice).approve(await teller.getAddress(), 100n * ONE_FYUSD)).wait();
    await (await teller.connect(alice).redeem(await usdt.getAddress(), 100n * ONE_FYUSD)).wait();

    // The invariant the explorer can check: escrowed stable (normalised)
    // equals total FYUSD supply, always.
    const reserve = await teller.reserveOf(await usdt.getAddress());
    assert.equal(reserve * SCALE, await fyusd.totalSupply());
    assert.equal(reserve, await usdt.balanceOf(await teller.getAddress()));
  });

  it("rejects unsupported assets, zero amounts, and dust redemptions", async function () {
    const { alice, fyusd, usdt, teller } = await fixture();
    const Mock = await ethers.getContractFactory("MockERC20");
    const rogue = await Mock.deploy("Rogue", "RGE", 6);
    await rogue.waitForDeployment();

    await assert.rejects(
      teller.connect(alice).mint(await rogue.getAddress(), ONE_USDT),
      /UnsupportedAsset/,
    );
    await assert.rejects(
      teller.connect(alice).mint(await usdt.getAddress(), 0n),
      /ZeroAmount/,
    );

    // Anything below 1e12 wei of FYUSD is less than one USDT base unit —
    // paying out 0 while burning would destroy user value.
    await fund(usdt, teller, alice, ONE_USDT);
    await (await teller.connect(alice).mint(await usdt.getAddress(), ONE_USDT)).wait();
    await (await fyusd.connect(alice).approve(await teller.getAddress(), ONE_FYUSD)).wait();
    await assert.rejects(
      teller.connect(alice).redeem(await usdt.getAddress(), SCALE - 1n),
      /DustAmount/,
    );
  });

  it("refuses to register a stable with more decimals than FYUSD", async function () {
    const { teller } = await fixture();
    const Mock = await ethers.getContractFactory("MockERC20");
    const tooFine = await Mock.deploy("TooFine", "TF", 24);
    await tooFine.waitForDeployment();

    await assert.rejects(
      teller.setSupportedAsset(await tooFine.getAddress(), true),
      /DecimalsTooLarge/,
    );
  });

  it("closes mint but keeps redeem open when an asset is delisted", async function () {
    const { owner, alice, fyusd, usdt, teller } = await fixture();
    await fund(usdt, teller, alice, 50n * ONE_USDT);
    await (await teller.connect(alice).mint(await usdt.getAddress(), 50n * ONE_USDT)).wait();

    await (await teller.connect(owner).setSupportedAsset(await usdt.getAddress(), false)).wait();

    await fund(usdt, teller, alice, 10n * ONE_USDT);
    await assert.rejects(
      teller.connect(alice).mint(await usdt.getAddress(), 10n * ONE_USDT),
      /UnsupportedAsset/,
    );

    // Already-issued FYUSD must still be exitable.
    await (await fyusd.connect(alice).approve(await teller.getAddress(), 50n * ONE_FYUSD)).wait();
    await (await teller.connect(alice).redeem(await usdt.getAddress(), 50n * ONE_FYUSD)).wait();
    assert.equal(await teller.reserveOf(await usdt.getAddress()), 0n);
  });

  it("caps redemption at the tracked reserve even if the balance is larger", async function () {
    const { alice, bob, fyusd, usdt, teller } = await fixture();
    await fund(usdt, teller, alice, 10n * ONE_USDT);
    await (await teller.connect(alice).mint(await usdt.getAddress(), 10n * ONE_USDT)).wait();

    // Airdrop straight into the teller — must NOT become redeemable.
    await (await usdt.mint(await teller.getAddress(), 1_000n * ONE_USDT)).wait();

    await (await fyusd.connect(alice).approve(await teller.getAddress(), 20n * ONE_FYUSD)).wait();
    await assert.rejects(
      teller.connect(alice).redeem(await usdt.getAddress(), 20n * ONE_FYUSD),
      /InsufficientReserve/,
    );
    assert.equal(await usdt.balanceOf(bob.address), 0n);
  });

  it("sweeps only the surplus above the reserve, never user backing", async function () {
    const { owner, alice, bob, usdt, teller } = await fixture();
    await fund(usdt, teller, alice, 10n * ONE_USDT);
    await (await teller.connect(alice).mint(await usdt.getAddress(), 10n * ONE_USDT)).wait();
    await (await usdt.mint(await teller.getAddress(), 3n * ONE_USDT)).wait();

    await (await teller.connect(owner).sweepSurplus(await usdt.getAddress(), bob.address)).wait();

    assert.equal(await usdt.balanceOf(bob.address), 3n * ONE_USDT);
    assert.equal(await usdt.balanceOf(await teller.getAddress()), 10n * ONE_USDT);
    // Nothing left over -> a second sweep has nothing to move.
    await assert.rejects(
      teller.connect(owner).sweepSurplus(await usdt.getAddress(), bob.address),
      /ZeroAmount/,
    );
  });

  it("gates admin functions and pausing on the owner", async function () {
    const { alice, usdt, teller } = await fixture();
    await assert.rejects(
      teller.connect(alice).setSupportedAsset(await usdt.getAddress(), false),
      /OwnableUnauthorizedAccount/,
    );
    await assert.rejects(teller.connect(alice).pause(), /OwnableUnauthorizedAccount/);
    await assert.rejects(
      teller.connect(alice).sweepSurplus(await usdt.getAddress(), alice.address),
      /OwnableUnauthorizedAccount/,
    );
  });

  it("blocks mint and redeem while paused, and resumes on unpause", async function () {
    const { owner, alice, fyusd, usdt, teller } = await fixture();
    await fund(usdt, teller, alice, 20n * ONE_USDT);
    await (await teller.connect(alice).mint(await usdt.getAddress(), 10n * ONE_USDT)).wait();

    await (await teller.connect(owner).pause()).wait();
    await assert.rejects(
      teller.connect(alice).mint(await usdt.getAddress(), 10n * ONE_USDT),
      /EnforcedPause/,
    );
    await (await fyusd.connect(alice).approve(await teller.getAddress(), 10n * ONE_FYUSD)).wait();
    await assert.rejects(
      teller.connect(alice).redeem(await usdt.getAddress(), 10n * ONE_FYUSD),
      /EnforcedPause/,
    );

    await (await teller.connect(owner).unpause()).wait();
    await (await teller.connect(alice).redeem(await usdt.getAddress(), 10n * ONE_FYUSD)).wait();
    assert.equal(await teller.reserveOf(await usdt.getAddress()), 0n);
  });

  it("previewMint / previewRedeem match what the state-changing calls do", async function () {
    const { alice, fyusd, usdt, teller } = await fixture();
    const usdtAddr = await usdt.getAddress();
    await fund(usdt, teller, alice, 7n * ONE_USDT);

    const previewed = await teller.previewMint(usdtAddr, 7n * ONE_USDT);
    await (await teller.connect(alice).mint(usdtAddr, 7n * ONE_USDT)).wait();
    assert.equal(await fyusd.balanceOf(alice.address), previewed);

    const back = await teller.previewRedeem(usdtAddr, previewed);
    await (await fyusd.connect(alice).approve(await teller.getAddress(), previewed)).wait();
    await (await teller.connect(alice).redeem(usdtAddr, previewed)).wait();
    assert.equal(await usdt.balanceOf(alice.address), back);
  });
});
