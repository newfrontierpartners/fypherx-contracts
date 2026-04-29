// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IInsuranceFund} from "./interfaces/IInsuranceFund.sol";

/// @title InsuranceFundV2
/// @notice Shared insurance fund across all Fypher lending markets.
///         - Accepts `safeTransfer`ed reserves from whitelisted markets (idempotently tracked).
///         - On `coverBadDebt`, pays the requesting market up to the available balance of the
///           requested loan token.
/// @dev Whitelist is managed by the owner (intended to be the Timelock). Markets register
///      themselves implicitly when governance calls `setMarketAllowed(..., true)`.
contract InsuranceFundV2 is IInsuranceFund, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Approved markets that may pull funds via `coverBadDebt`.
    mapping(address => bool) public allowedMarket;

    /// @notice Address allowed to add/remove markets to `allowedMarket` without going through
    ///         the owner (Timelock). Intended to be set once to the `FypherLendingMarketFactory`.
    address public factory;

    /// @notice Per-token cumulative reserves received from `onReservesReceived` calls (reporting only).
    mapping(address => uint256) public cumulativeReserves;
    /// @notice Per-token cumulative bad-debt coverage paid out.
    mapping(address => uint256) public cumulativeBadDebtCovered;

    event MarketAllowedSet(address indexed market, bool allowed);
    event FactorySet(address indexed factory);
    event ReservesAccepted(address indexed market, address indexed token, uint256 amount);
    event BadDebtCovered(address indexed market, address indexed token, uint256 requested, uint256 covered);
    event Withdrawn(address indexed to, address indexed token, uint256 amount);

    error NotAllowedMarket();
    error NotFactoryOrOwner();

    constructor(address owner_) Ownable(owner_) {}

    function setFactory(address factory_) external onlyOwner {
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setMarketAllowed(address market, bool allowed) external {
        if (msg.sender != owner() && msg.sender != factory) revert NotFactoryOrOwner();
        allowedMarket[market] = allowed;
        emit MarketAllowedSet(market, allowed);
    }

    /// @inheritdoc IInsuranceFund
    function onReservesReceived(address token, uint256 amount) external override {
        if (!allowedMarket[msg.sender]) revert NotAllowedMarket();
        cumulativeReserves[token] += amount;
        emit ReservesAccepted(msg.sender, token, amount);
    }

    /// @inheritdoc IInsuranceFund
    function coverBadDebt(address token, uint256 amount) external override returns (uint256 covered) {
        if (!allowedMarket[msg.sender]) revert NotAllowedMarket();

        uint256 balance = IERC20(token).balanceOf(address(this));
        covered = amount <= balance ? amount : balance;

        if (covered > 0) {
            cumulativeBadDebtCovered[token] += covered;
            IERC20(token).safeTransfer(msg.sender, covered);
        }

        emit BadDebtCovered(msg.sender, token, amount, covered);
    }

    /// @notice Owner-only emergency exit — move idle reserves to the given recipient.
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(to, token, amount);
    }
}
