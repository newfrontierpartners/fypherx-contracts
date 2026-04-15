// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FypherXInsuranceFundVault {
    address public owner;
    mapping(address => bool) public operators;

    event OperatorUpdated(address indexed operator, bool allowed);
    event FundDeposited(address indexed from, uint256 amount, bytes32 referenceId);
    event FundWithdrawn(address indexed to, uint256 amount, bytes32 referenceId);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOperator() {
        require(operators[msg.sender], "not operator");
        _;
    }

    constructor(address initialOperator) {
        owner = msg.sender;
        operators[initialOperator] = true;
        emit OperatorUpdated(initialOperator, true);
    }

    receive() external payable {
        emit FundDeposited(msg.sender, msg.value, bytes32(0));
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    function withdraw(address payable to, uint256 amount, bytes32 referenceId) external onlyOperator {
        require(address(this).balance >= amount, "insufficient vault balance");
        (bool success, ) = to.call{value: amount}("");
        require(success, "withdraw failed");
        emit FundWithdrawn(to, amount, referenceId);
    }
}
