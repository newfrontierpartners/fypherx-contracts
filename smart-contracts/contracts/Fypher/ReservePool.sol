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

    event ETHWithdrawn(address indexed to, uint256 amount);

    error NotAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientETH(uint256 have, uint256 want);
    error ETHTransferFailed();

    modifier onlyAdmin() {
        if (!settingManagement.hasRole(bytes32(0), msg.sender)) revert NotAdmin();
        _;
    }

    constructor(ISettingManagement _settingManagement) {
        // FYP-25: reject zero setting-management binding (immutable —
        // we cannot recover from a wrong constructor arg post-deploy).
        if (address(_settingManagement) == address(0)) revert ZeroAddress();
        settingManagement = _settingManagement;
    }

    /// @notice Distribute funds from reserve to a recipient
    function distributeFunds(address token, address to, uint256 amount) external onlyAdmin {
        // FYP-25: zero recipient address would burn the transfer; the
        // amount==0 case is allowed (it's a cheap no-op).
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Emergency withdrawal of all balance of a token
    function emergencyWithdraw(address token, address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(to, balance);
        }
    }

    /**
     * @notice Withdraw `amount` of native ETH to `to`. Admin-only.
     *
     * @dev FYP-27 patch. {receive()} below accepts native ETH, but
     *      prior to this patch the contract had no exit path for it,
     *      so any ETH sent in (intentionally or by mistake) became
     *      permanently locked. The new entry-point closes that gap.
     *      Uses {.call} so the receiver may itself be a contract
     *      with non-trivial fallback logic (e.g. a Safe multisig).
     */
    function withdrawETH(address to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = address(this).balance;
        if (bal < amount) revert InsufficientETH(bal, amount);
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert ETHTransferFailed();
        emit ETHWithdrawn(to, amount);
    }

    /// @notice Accept native ETH
    receive() external payable {}
}
