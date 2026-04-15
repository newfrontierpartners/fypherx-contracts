// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISettingManagement.sol";

/**
 * @title ReservePool
 * @notice Protocol reserve management — holds emergency liquidity.
 *         Target: 3% of redeemable supply. Only admin can distribute or withdraw.
 *
 * @dev NOT a proxy — direct deployment. Simple contract (7 ABI entries).
 *      Deployed at: 0xCCCd5dC68Ed8ad2B9b4F2255428671C16C64D6dC
 */
contract ReservePool {
    using SafeERC20 for IERC20;

    ISettingManagement public immutable settingManagement;

    error NotAdmin();

    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    constructor(ISettingManagement _settingManagement) {
        settingManagement = _settingManagement;
    }

    /// @notice Distribute funds from reserve to a recipient
    function distributeFunds(address token, address to, uint256 amount) external onlyAdmin {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Emergency withdrawal of all balance of a token
    function emergencyWithdraw(address token, address to) external onlyAdmin {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(to, balance);
        }
    }

    /// @notice Accept native BNB
    receive() external payable {}
}
