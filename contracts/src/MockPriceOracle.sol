// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockPriceOracle {
    uint8 public immutable decimals;
    int256 private latestAnswer;
    uint80 private latestRoundId;
    uint256 private latestUpdatedAt;

    event AnswerUpdated(int256 answer, uint80 roundId, uint256 updatedAt);

    constructor(uint8 decimals_, int256 initialAnswer_) {
        decimals = decimals_;
        setLatestAnswer(initialAnswer_);
    }

    function setLatestAnswer(int256 newAnswer) public {
        latestRoundId += 1;
        latestAnswer = newAnswer;
        latestUpdatedAt = block.timestamp;
        emit AnswerUpdated(newAnswer, latestRoundId, latestUpdatedAt);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (latestRoundId, latestAnswer, latestUpdatedAt, latestUpdatedAt, latestRoundId);
    }
}
