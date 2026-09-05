const { ethers } = require("hardhat");
const ADDRESSES = require("../deployed-addresses.json");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const mintingAbi = [
    "function addCustodianAddress(address) external",
    "function custodianAddresses(address) view returns (bool)",
    "function backendSigner() view returns (address)",
  ];

  const minting = await ethers.getContractAt(mintingAbi, ADDRESSES.FypherMinting);

  const isCustodian = await minting.custodianAddresses(deployer.address);
  const signer = await minting.backendSigner();
  console.log("Is custodian:", isCustodian);
  console.log("Backend signer:", signer);

  if (!isCustodian) {
    console.log("Adding deployer as custodian...");
    const tx = await minting.addCustodianAddress(deployer.address);
    await tx.wait();
    console.log("Done! Deployer is now a custodian.");
  } else {
    console.log("Already a custodian.");
  }
}

main().catch(console.error);
