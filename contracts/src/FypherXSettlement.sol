// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FypherXSettlement {
    address public owner;
    mapping(address => bool) public relayers;
    mapping(bytes32 => bool) public settledTrades;

    event RelayerUpdated(address indexed relayer, bool allowed);
    event TradeSettled(
        bytes32 indexed tradeId,
        bytes32 indexed marketId,
        bytes32 makerSubaccountId,
        bytes32 takerSubaccountId,
        uint256 priceE18,
        uint256 quantityE18,
        uint256 makerFeeE18,
        uint256 takerFeeE18,
        bytes payload
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyRelayer() {
        require(relayers[msg.sender], "not relayer");
        _;
    }

    constructor(address initialRelayer) {
        owner = msg.sender;
        relayers[initialRelayer] = true;
        emit RelayerUpdated(initialRelayer, true);
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        relayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function settleTrade(
        bytes32 tradeId,
        bytes32 marketId,
        bytes32 makerSubaccountId,
        bytes32 takerSubaccountId,
        uint256 priceE18,
        uint256 quantityE18,
        uint256 makerFeeE18,
        uint256 takerFeeE18,
        bytes calldata payload
    ) external onlyRelayer {
        require(!settledTrades[tradeId], "trade already settled");
        settledTrades[tradeId] = true;

        emit TradeSettled(
            tradeId,
            marketId,
            makerSubaccountId,
            takerSubaccountId,
            priceE18,
            quantityE18,
            makerFeeE18,
            takerFeeE18,
            payload
        );
    }
}
