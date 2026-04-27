// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockWETH
 * @notice Minimal WETH9-shaped mock used by FypherMinting.mintWETH tests.
 *         {deposit} mints wrapped tokens 1:1 with msg.value to the caller;
 *         {withdraw} burns and refunds. Standard ERC20 transfer semantics
 *         from the OpenZeppelin base.
 */
contract MockWETH is ERC20 {
    error InsufficientBalance();

    event Deposit(address indexed to, uint256 amount);
    event Withdrawal(address indexed from, uint256 amount);

    constructor() ERC20("Wrapped Ether (mock)", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (balanceOf(msg.sender) < amount) revert InsufficientBalance();
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "WETH: refund failed");
        emit Withdrawal(msg.sender, amount);
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }
}
