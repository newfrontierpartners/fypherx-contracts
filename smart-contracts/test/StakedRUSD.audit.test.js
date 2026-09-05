/**
 * StakedRUSD audit-lingering verification.
 *
 * Targets two CertiK May-2026 findings that were resolved-with-comments:
 *
 *   FYP-03 lingering: {_update} principal-move now uses share-fraction
 *     math instead of `previewRedeem(value)` (NAV-equivalent), so
 *     self-transfer no longer inflates `userStakedAmount` by accrued
 *     rewards.
 *
 *   FYP-06 lingering: {previewWithdraw} / {previewRedeem} return 0
 *     (matching {maxWithdraw} / {maxRedeem}), and the cooldown flow
 *     reaches the OZ conversion math through {_convertToShares} /
 *     {_convertToAssets} directly so cooldown behavior is unchanged.
 */
const assert = require("node:assert/strict");
const { ethers, upgrades, network } = require("hardhat");

const ONE = 10n ** 18n;

async function deployFixture() {
    const [deployer, alice, bob, rewarder] = await ethers.getSigners();

    const SettingManagement = await ethers.getContractFactory("SettingManagement");
    const setting = await upgrades.deployProxy(SettingManagement, [deployer.address], {
        initializer: "initialize", kind: "transparent",
    });

    // Grant REWARDER_ROLE so we can fund vault rewards.
    const REWARDER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REWARDER_ROLE"));
    await (await setting.grantRole(REWARDER_ROLE, rewarder.address)).wait();

    // Configure a real cooldown duration (otherwise the cooldown is instant
    // — fine for FYP-37 follow-up, but for these tests we want the
    // proper 7-day window).
    await (await setting.setPoolConfigs("cooldownDuration", 7 * 24 * 60 * 60)).wait();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const rusd = await MockERC20.deploy("Mock RUSD", "mRUSD", 18);

    const StakedRUSD = await ethers.getContractFactory("StakedRUSD");
    const sRUSD = await upgrades.deployProxy(
        StakedRUSD,
        [await rusd.getAddress(), await setting.getAddress(), deployer.address],
        { initializer: "initialize", kind: "transparent" },
    );

    // Seed Alice + Bob + rewarder with mock RUSD.
    for (const u of [alice, bob, rewarder]) {
        await (await rusd.mint(u.address, 10_000n * ONE)).wait();
        await (await rusd.connect(u).approve(await sRUSD.getAddress(), ethers.MaxUint256)).wait();
    }

    return { deployer, alice, bob, rewarder, rusd, sRUSD, setting };
}

describe("FYP-03 lingering — share-fraction principal accounting", () => {
    it("self-transfer leaves userStakedAmount equal to the original principal even after rewards accrue", async () => {
        const { alice, rewarder, rusd, sRUSD } = await deployFixture();

        // Alice deposits 100 RUSD principal.
        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        assert.equal(await sRUSD.userStakedAmount(alice.address), 100n * ONE);

        // Reward distribution: rewarder funds 50 RUSD into the vault. NAV
        // grows linearly over the 8h release window; we fast-forward
        // half the window so totalAssets reflects ~25 RUSD of additional
        // value.
        await (await sRUSD.connect(rewarder).transferInRewards(50n * ONE)).wait();
        await network.provider.send("evm_increaseTime", [4 * 60 * 60]); // 4h of 8h
        await network.provider.send("evm_mine", []);

        const shares = await sRUSD.balanceOf(alice.address);

        // FYP-03 pre-patch behaviour: previewRedeem(shares) > 100 because
        // it includes the released portion of the reward. The buggy code
        // would have set userStakedAmount[alice] to that NAV figure.
        // The new share-fraction math should keep principal at 100.
        await (await sRUSD.connect(alice).transfer(alice.address, shares)).wait();

        assert.equal(
            await sRUSD.userStakedAmount(alice.address),
            100n * ONE,
            "self-transfer must leave userStakedAmount untouched",
        );
    });

    it("partial transfer to another user splits principal proportionally with the shares", async () => {
        const { alice, bob, rusd, sRUSD } = await deployFixture();

        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        const shares = await sRUSD.balanceOf(alice.address);

        // Transfer half the shares to Bob.
        await (await sRUSD.connect(alice).transfer(bob.address, shares / 2n)).wait();

        assert.equal(await sRUSD.userStakedAmount(alice.address), 50n * ONE);
        assert.equal(await sRUSD.userStakedAmount(bob.address), 50n * ONE);
    });

    it("full transfer to another user moves all principal", async () => {
        const { alice, bob, sRUSD } = await deployFixture();

        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        const shares = await sRUSD.balanceOf(alice.address);

        await (await sRUSD.connect(alice).transfer(bob.address, shares)).wait();

        assert.equal(await sRUSD.userStakedAmount(alice.address), 0n);
        assert.equal(await sRUSD.userStakedAmount(bob.address), 100n * ONE);
    });

    it("transferring after rewards moves only the principal share, not the accrued rewards", async () => {
        const { alice, bob, rewarder, sRUSD } = await deployFixture();

        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();

        // Fund 50 RUSD of rewards. With the 8-hour streaming window we
        // wait the full release so totalAssets reflects 150 RUSD.
        await (await sRUSD.connect(rewarder).transferInRewards(50n * ONE)).wait();
        await network.provider.send("evm_increaseTime", [8 * 60 * 60 + 1]);
        await network.provider.send("evm_mine", []);

        const shares = await sRUSD.balanceOf(alice.address);
        await (await sRUSD.connect(alice).transfer(bob.address, shares / 2n)).wait();

        // Principal accounting is share-fraction based, so each side
        // gets exactly half of the original 100 RUSD principal — even
        // though the NAV of the transferred shares is 75 RUSD.
        assert.equal(await sRUSD.userStakedAmount(alice.address), 50n * ONE);
        assert.equal(await sRUSD.userStakedAmount(bob.address), 50n * ONE);
    });
});

describe("FYP-06 lingering — preview*() returns 0 + cooldown unaffected", () => {
    it("previewWithdraw and previewRedeem return 0 regardless of input", async () => {
        const { sRUSD } = await deployFixture();

        assert.equal(await sRUSD.previewWithdraw(123n * ONE), 0n);
        assert.equal(await sRUSD.previewRedeem(456n * ONE), 0n);
        assert.equal(await sRUSD.maxWithdraw(ethers.ZeroAddress), 0n);
        assert.equal(await sRUSD.maxRedeem(ethers.ZeroAddress), 0n);
    });

    it("convertToShares / convertToAssets remain accurate for off-chain estimation", async () => {
        const { alice, sRUSD } = await deployFixture();

        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        const shares = await sRUSD.balanceOf(alice.address);

        // The public convertTo* surface is still meaningful for clients
        // that want to size cooldown calls. previewWithdraw/preview-
        // Redeem are gated; convertToShares/convertToAssets are not.
        const convertedAssets = await sRUSD.convertToAssets(shares);
        assert.ok(convertedAssets > 0n);
    });

    it("cooldownAssets still works after preview overrides", async () => {
        const { alice, sRUSD } = await deployFixture();

        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        await (await sRUSD.connect(alice).cooldownAssets(40n * ONE)).wait();

        const cd = await sRUSD.cooldowns(alice.address);
        assert.equal(cd.underlyingAmount, 40n * ONE);
        // userStakedAmount debited by the cooldown.
        assert.equal(await sRUSD.userStakedAmount(alice.address), 60n * ONE);
    });

    it("cooldownShares still works after preview overrides", async () => {
        const { alice, sRUSD } = await deployFixture();

        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        const half = (await sRUSD.balanceOf(alice.address)) / 2n;
        await (await sRUSD.connect(alice).cooldownShares(half)).wait();

        const cd = await sRUSD.cooldowns(alice.address);
        // No rewards funded → 1:1 NAV → half the shares == 50 RUSD.
        assert.equal(cd.underlyingAmount, 50n * ONE);
    });

    it("direct withdraw and redeem still revert with CooldownRequired", async () => {
        const { alice, sRUSD } = await deployFixture();

        await (await sRUSD.connect(alice).deposit(100n * ONE, alice.address)).wait();
        await assert.rejects(
            sRUSD.connect(alice).withdraw(10n * ONE, alice.address, alice.address),
            (err) => err.message.includes("CooldownRequired"),
        );
        await assert.rejects(
            sRUSD.connect(alice).redeem(10n * ONE, alice.address, alice.address),
            (err) => err.message.includes("CooldownRequired"),
        );
    });
});
