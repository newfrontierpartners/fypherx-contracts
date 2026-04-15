const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("FypherXInsuranceFundVault", function () {
  async function deployFixture() {
    const [owner, operator, recipient, outsider] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("FypherXInsuranceFundVault");
    const vault = await Vault.deploy(operator.address);
    return { owner, operator, recipient, outsider, vault };
  }

  it("accepts deposits and lets only operators withdraw", async function () {
    const { operator, recipient, outsider, vault } = await deployFixture();

    await operator.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("5"),
    });

    await assert.rejects(
      vault.connect(outsider).withdraw(recipient.address, ethers.parseEther("1"), ethers.id("w1"))
    , /not operator/);

    const vaultBalanceBefore = await ethers.provider.getBalance(await vault.getAddress());
    const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);

    const tx = await vault.connect(operator).withdraw(recipient.address, ethers.parseEther("1"), ethers.id("w1"));
    await tx.wait();

    const vaultBalanceAfter = await ethers.provider.getBalance(await vault.getAddress());
    const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);
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
