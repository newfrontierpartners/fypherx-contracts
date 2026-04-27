const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherXInsuranceFundVault", function () {
  async function deployFixture() {
    const [owner, operator, recipient, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Mock USD", "mUSD", 18);

    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");
    const vault = await Vault.deploy(await token.getAddress(), operator.address);

    const amount = ethers.parseUnits("1000", 18);
    await token.mint(operator.address, amount);
    await token.connect(operator).approve(await vault.getAddress(), amount);

    return { owner, operator, recipient, outsider, token, vault, amount };
  }

  // ── Deployment ──────────────────────────────────────────────────────────
  it("sets owner and initial operator on deploy", async function () {
    const { owner, operator, vault } = await deployFixture();
    assert.equal(await vault.owner(), owner.address);
    assert.equal(await vault.operators(operator.address), true);
  });

  it("reverts deploy with zero token address", async function () {
    const [, operator] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");
    await assert.rejects(
      Vault.deploy(ethers.ZeroAddress, operator.address),
      /invalid token/
    );
  });

  // ── setOwner ────────────────────────────────────────────────────────────
  it("allows owner to transfer ownership", async function () {
    const { owner, outsider, vault } = await deployFixture();
    await vault.connect(owner).setOwner(outsider.address);
    assert.equal(await vault.owner(), outsider.address);
  });

  it("rejects setOwner from non-owner", async function () {
    const { outsider, vault } = await deployFixture();
    await assert.rejects(
      vault.connect(outsider).setOwner(outsider.address),
      /not owner/
    );
  });

  it("rejects setOwner to zero address", async function () {
    const { owner, vault } = await deployFixture();
    await assert.rejects(
      vault.connect(owner).setOwner(ethers.ZeroAddress),
      /invalid owner/
    );
  });

  // ── setOperator ─────────────────────────────────────────────────────────
  it("allows owner to add and revoke operators", async function () {
    const { owner, outsider, vault } = await deployFixture();
    await vault.connect(owner).setOperator(outsider.address, true);
    assert.equal(await vault.operators(outsider.address), true);
    await vault.connect(owner).setOperator(outsider.address, false);
    assert.equal(await vault.operators(outsider.address), false);
  });

  it("rejects setOperator from non-owner", async function () {
    const { outsider, vault } = await deployFixture();
    await assert.rejects(
      vault.connect(outsider).setOperator(outsider.address, true),
      /not owner/
    );
  });

  // ── deposit ─────────────────────────────────────────────────────────────
  it("accepts deposits and lets only operators withdraw", async function () {
    const { operator, recipient, outsider, token, vault } = await deployFixture();
    const dep = ethers.parseEther("5");
    await token.mint(operator.address, dep);
    await token.connect(operator).approve(await vault.getAddress(), dep);
    await vault.connect(operator).deposit(dep, ethers.id("d1"));

    await assert.rejects(
      vault.connect(outsider).withdraw(recipient.address, ethers.parseEther("1"), ethers.id("w1")),
      /not operator/
    );

    const vaultBefore = await token.balanceOf(await vault.getAddress());
    const recipientBefore = await token.balanceOf(recipient.address);
    await vault.connect(operator).withdraw(recipient.address, ethers.parseEther("1"), ethers.id("w1"));
    assert.equal(vaultBefore - (await token.balanceOf(await vault.getAddress())), ethers.parseEther("1"));
    assert.equal((await token.balanceOf(recipient.address)) - recipientBefore, ethers.parseEther("1"));
  });

  it("rejects zero deposit", async function () {
    const { operator, vault } = await deployFixture();
    await assert.rejects(
      vault.connect(operator).deposit(0n, ethers.id("zero")),
      /invalid deposit/
    );
  });

  // ── withdraw ────────────────────────────────────────────────────────────
  it("rejects withdrawals above the vault balance", async function () {
    const { operator, recipient, vault } = await deployFixture();
    await assert.rejects(
      vault.connect(operator).withdraw(recipient.address, ethers.parseEther("1"), ethers.id("w2")),
      /insufficient vault balance/
    );
  });

  it("rejects non-operator withdrawals", async function () {
    const { outsider, operator, recipient, vault, amount } = await deployFixture();
    await vault.connect(operator).deposit(amount, ethers.id("d1"));
    await assert.rejects(
      vault.connect(outsider).withdraw(recipient.address, amount, ethers.id("w1")),
      /not operator/
    );
  });

  it("rejects withdraw with zero amount", async function () {
    const { operator, recipient, vault, amount } = await deployFixture();
    await vault.connect(operator).deposit(amount, ethers.id("d1"));
    await assert.rejects(
      vault.connect(operator).withdraw(recipient.address, 0n, ethers.id("w0")),
      /invalid amount/
    );
  });

  it("rejects withdraw to zero address", async function () {
    const { operator, vault, amount } = await deployFixture();
    await vault.connect(operator).deposit(amount, ethers.id("d1"));
    await assert.rejects(
      vault.connect(operator).withdraw(ethers.ZeroAddress, amount, ethers.id("wz")),
      /invalid recipient/
    );
  });

  // ── balance ─────────────────────────────────────────────────────────────
  it("balance reflects cumulative deposits and withdrawals", async function () {
    const { operator, recipient, vault } = await deployFixture();
    const half = ethers.parseUnits("500", 18);
    assert.equal(await vault.balance(), 0n);
    await vault.connect(operator).deposit(half, ethers.id("d1"));
    assert.equal(await vault.balance(), half);
    await vault.connect(operator).deposit(half, ethers.id("d2"));
    assert.equal(await vault.balance(), half * 2n);
    await vault.connect(operator).withdraw(recipient.address, half, ethers.id("w1"));
    assert.equal(await vault.balance(), half);
  });
});
