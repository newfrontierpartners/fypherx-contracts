// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Forces Hardhat to compile OpenZeppelin contracts we deploy by name via
// ethers.getContractFactory but never import in our own Solidity sources.
// Adding an import here is the lowest-ceremony way to expose the artifact.

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
