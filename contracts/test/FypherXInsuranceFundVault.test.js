const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherXInsuranceFundVault", function () {
  async function deployFixture() {
    const [owner, operator, recipient, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Mock USD", "mUSD", 18);

    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");
    const vault = await Vault.deploy(await token.getAddress(), operator.address);
    return { owner, operator, recipient, outsider, token, vault };
  }

  it("accepts deposits and lets only operators withdraw", async function () {
    const { operator, recipient, outsider, token, vault } = await deployFixture();

    // April-audit M-9: vault is now ERC-20 backed. Mint and deposit
    // through the new ERC-20 path instead of native send.
    const amount = ethers.parseEther("5");
    await token.mint(operator.address, amount);
    await token.connect(operator).approve(await vault.getAddress(), amount);
    await vault.connect(operator).deposit(amount, ethers.id("d1"));

    await assert.rejects(
      vault.connect(outsider).withdraw(recipient.address, ethers.parseEther("1"), ethers.id("w1"))
    , /not operator/);

    const vaultBalanceBefore = await token.balanceOf(await vault.getAddress());
    const recipientBalanceBefore = await token.balanceOf(recipient.address);

    const tx = await vault.connect(operator).withdraw(recipient.address, ethers.parseEther("1"), ethers.id("w1"));
    await tx.wait();

    const vaultBalanceAfter = await token.balanceOf(await vault.getAddress());
    const recipientBalanceAfter = await token.balanceOf(recipient.address);
    assert.equal(vaultBalanceBefore - vaultBalanceAfter, ethers.parseEther("1"));
    assert.equal(recipientBalanceAfter - recipientBalanceBefore, ethers.parseEther("1"));
  });

  it("rejects withdrawals above the vault balance", async function () {
    const { operator, recipient, vault } = await deployFixture();
    await assert.rejects(
      vault.connect(operator).withdraw(recipient.address, ethers.parseEther("1"), ethers.id("w2"))
    , /insufficient vault balance/);
  });
});
