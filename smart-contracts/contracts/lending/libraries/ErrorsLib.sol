// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/// @title ErrorsLib
/// @notice Custom errors used across the Fypher lending market.
library ErrorsLib {
    /* ACCESS CONTROL */
    error NotTimelock();
    error NotAuthorized();
    error ZeroAddress();

    /* LIFECYCLE */
    error Paused();
    error AlreadyInitialized();

    /* INPUT */
    error ZeroAmount();
    error InconsistentInput();
    error LltvTooHigh();
    error LiquidationBonusTooHigh();
    error ReserveFactorTooHigh();

    /* ACCOUNTING */
    error InsufficientLiquidity();
    error InsufficientCollateral();
    error InsufficientShares();
    error SupplyCapExceeded();
    error BorrowCapExceeded();

    /* HEALTH */
    error HealthyPosition();
    error InconsistentOracle();
}
