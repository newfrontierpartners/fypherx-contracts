// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IChainlinkLikeOracle {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

contract FypherOracleRouter {
    struct OracleConfig {
        address feed;
        uint8 feedDecimals;
        uint32 maxStaleness;
        bool active;
    }

    address public owner;
    mapping(bytes32 => OracleConfig) public marketOracles;

    /**
     * @notice Global emergency switch. When `true`, every {getPriceE18}
     *         call reverts — every dependent contract (clearinghouse,
     *         risk view aggregators) freezes by reverting on price
     *         reads, with no per-market reconfiguration required.
     *
     * @dev April-audit M-10 patch. Previously a flapping or
     *      manipulated feed could only be defused per-market
     *      (`active = false`), requiring the operator to know the
     *      full market list and process each one in a separate tx.
     *      The global flag gives a single-tx kill-switch.
     */
    bool public paused;

    event OwnerUpdated(address indexed previousOwner, address indexed nextOwner);
    event MarketOracleConfigured(
        bytes32 indexed marketId,
        address indexed feed,
        uint8 feedDecimals,
        uint32 maxStaleness,
        bool active
    );
    event Paused(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerUpdated(address(0), msg.sender);
    }

    function setOwner(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "invalid owner");
        emit OwnerUpdated(owner, nextOwner);
        owner = nextOwner;
    }

    /**
     * @notice Toggle the global pause. Emits {Paused} regardless of
     *         whether the state actually changed (callers can use the
     *         event as an explicit confirmation).
     */
    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit Paused(nextPaused);
    }

    function configureMarketOracle(
        bytes32 marketId,
        address feed,
        uint8 feedDecimals,
        uint32 maxStaleness,
        bool active
    ) external onlyOwner {
        require(feed != address(0), "invalid feed");
        require(maxStaleness > 0, "invalid staleness");

        marketOracles[marketId] = OracleConfig({
            feed: feed,
            feedDecimals: feedDecimals,
            maxStaleness: maxStaleness,
            active: active
        });

        emit MarketOracleConfigured(marketId, feed, feedDecimals, maxStaleness, active);
    }

    function getPriceE18(bytes32 marketId) external view returns (uint256) {
        require(!paused, "oracle paused");
        OracleConfig memory config = marketOracles[marketId];
        require(config.active, "oracle inactive");
        require(config.feed != address(0), "oracle missing");

        (, int256 answer, , uint256 updatedAt, ) = IChainlinkLikeOracle(config.feed).latestRoundData();
        require(answer > 0, "invalid oracle price");
        require(updatedAt > 0, "oracle round missing");
        require(block.timestamp - updatedAt <= config.maxStaleness, "stale oracle price");

        return _scaleToE18(uint256(answer), config.feedDecimals);
    }

    function _scaleToE18(uint256 value, uint8 decimals_) internal pure returns (uint256) {
        if (decimals_ == 18) {
            return value;
        }
        if (decimals_ < 18) {
            return value * (10 ** (18 - decimals_));
        }
        return value / (10 ** (decimals_ - 18));
    }
}
