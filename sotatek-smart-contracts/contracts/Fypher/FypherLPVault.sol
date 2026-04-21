// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Subset of the Pancake V2 / Uniswap V2 Router 02 interface we rely on.
interface IUniswapV2Router02 {
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);
}

/// @title FypherLPVault
/// @notice User-facing share-token wrapper around a Pancake V2 (RUSD / quoteToken) liquidity pair.
///         Depositors hand over a pair of tokens; the vault adds liquidity via the PancakeV2
///         router and mints ERC-20 shares proportional to the LP tokens received. Withdrawers
///         burn shares and pull their pro-rata underlying back through the router.
/// @dev Shares are an ERC-20 called `LP-Vault:<symbol>` with 18 decimals. `emergencyWithdraw`
///      skips the router and hands out raw LP tokens — useful if the pair is disrupted.
contract FypherLPVault is ERC20, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable rusd;
    IERC20 public immutable quoteToken;
    IERC20 public immutable pair;          // the Pancake V2 LP ERC-20
    IUniswapV2Router02 public immutable router;

    bool public depositsPaused;

    event Deposit(
        address indexed caller,
        address indexed recipient,
        uint256 rusdIn,
        uint256 quoteIn,
        uint256 lpMinted,
        uint256 sharesMinted
    );
    event Withdraw(
        address indexed caller,
        address indexed recipient,
        uint256 sharesBurned,
        uint256 lpRemoved,
        uint256 rusdOut,
        uint256 quoteOut
    );
    event EmergencyWithdraw(address indexed caller, uint256 sharesBurned, uint256 lpOut);
    event DepositsPausedSet(bool paused);

    error DepositsArePaused();
    error DeadlineExpired();
    error ZeroAmount();
    error NoSharesMinted();

    constructor(
        address owner_,
        IERC20 rusd_,
        IERC20 quoteToken_,
        IERC20 pair_,
        IUniswapV2Router02 router_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        rusd = rusd_;
        quoteToken = quoteToken_;
        pair = pair_;
        router = router_;
    }

    /* ------------------------------------------------------------------ */
    /*                            ADMIN (OWNER)                           */
    /* ------------------------------------------------------------------ */

    function setDepositsPaused(bool value) external onlyOwner {
        depositsPaused = value;
        emit DepositsPausedSet(value);
    }

    /* ------------------------------------------------------------------ */
    /*                                 USER                               */
    /* ------------------------------------------------------------------ */

    function deposit(
        uint256 rusdAmount,
        uint256 quoteAmount,
        uint256 rusdMin,
        uint256 quoteMin,
        uint256 deadline,
        address recipient
    ) external nonReentrant returns (uint256 sharesMinted) {
        if (depositsPaused) revert DepositsArePaused();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (rusdAmount == 0 || quoteAmount == 0) revert ZeroAmount();

        rusd.safeTransferFrom(msg.sender, address(this), rusdAmount);
        quoteToken.safeTransferFrom(msg.sender, address(this), quoteAmount);

        rusd.forceApprove(address(router), rusdAmount);
        quoteToken.forceApprove(address(router), quoteAmount);

        (uint256 usedRusd, uint256 usedQuote, uint256 lpReceived) = router.addLiquidity(
            address(rusd),
            address(quoteToken),
            rusdAmount,
            quoteAmount,
            rusdMin,
            quoteMin,
            address(this),
            deadline
        );

        // Refund the leftover leg that the router didn't consume.
        if (rusdAmount > usedRusd) rusd.safeTransfer(msg.sender, rusdAmount - usedRusd);
        if (quoteAmount > usedQuote) quoteToken.safeTransfer(msg.sender, quoteAmount - usedQuote);

        uint256 totalLpBefore = totalLp() - lpReceived;
        if (totalSupply() == 0 || totalLpBefore == 0) {
            sharesMinted = lpReceived;
        } else {
            sharesMinted = (lpReceived * totalSupply()) / totalLpBefore;
        }
        if (sharesMinted == 0) revert NoSharesMinted();

        _mint(recipient, sharesMinted);

        emit Deposit(msg.sender, recipient, usedRusd, usedQuote, lpReceived, sharesMinted);
    }

    function withdraw(
        uint256 shares,
        uint256 rusdMin,
        uint256 quoteMin,
        uint256 deadline,
        address recipient
    ) external nonReentrant returns (uint256 rusdOut, uint256 quoteOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (shares == 0) revert ZeroAmount();

        uint256 lpToRemove = (shares * totalLp()) / totalSupply();
        _burn(msg.sender, shares);

        pair.forceApprove(address(router), lpToRemove);
        (rusdOut, quoteOut) = router.removeLiquidity(
            address(rusd),
            address(quoteToken),
            lpToRemove,
            rusdMin,
            quoteMin,
            recipient,
            deadline
        );

        emit Withdraw(msg.sender, recipient, shares, lpToRemove, rusdOut, quoteOut);
    }

    function emergencyWithdraw(uint256 shares) external nonReentrant returns (uint256 lpOut) {
        if (shares == 0) revert ZeroAmount();

        lpOut = (shares * totalLp()) / totalSupply();
        _burn(msg.sender, shares);
        pair.safeTransfer(msg.sender, lpOut);

        emit EmergencyWithdraw(msg.sender, shares, lpOut);
    }

    /* ------------------------------------------------------------------ */
    /*                                 VIEWS                              */
    /* ------------------------------------------------------------------ */

    function totalLp() public view returns (uint256) {
        return pair.balanceOf(address(this));
    }

    function lpOf(address user) external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        return (balanceOf(user) * totalLp()) / supply;
    }

    function underlyingOf(address user) external view returns (uint256 rusdAmount, uint256 quoteAmount) {
        uint256 supply = totalSupply();
        if (supply == 0) return (0, 0);

        uint256 pairSupply = IERC20(address(pair)).totalSupply();
        uint256 userLp = (balanceOf(user) * totalLp()) / supply;

        rusdAmount = (userLp * rusd.balanceOf(address(pair))) / pairSupply;
        quoteAmount = (userLp * quoteToken.balanceOf(address(pair))) / pairSupply;
    }
}
