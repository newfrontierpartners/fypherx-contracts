// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockPancakePair
 * @notice Minimal Uniswap/Pancake V2-style pair LP token used in tests only.
 *         Mint / burn are gated to a single `minter` (the mock router) so the
 *         supply invariants match the production router/pair relationship.
 *
 *         Does NOT implement swap / sync / skim — FypherLPVault never calls
 *         those. Reserve accounting lives on the mock router so the pair is
 *         purely the ERC-20 surface the vault observes (balanceOf + totalSupply).
 */
contract MockPancakePair is ERC20 {
    address public minter;

    constructor() ERC20("Mock Pancake Pair", "MCP-LP") {}

    /// Called once post-deploy by the mock router that will mint/burn this pair.
    function setMinter(address minter_) external {
        require(minter == address(0), "minter already set");
        minter = minter_;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "pair: not minter");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == minter, "pair: not minter");
        _burn(from, amount);
    }

    /// Ship tokens that the router previously parked in this pair back out.
    /// Only the router (minter) may call — matches PCS V2's router-only skim.
    function pullTo(address token, address to, uint256 amount) external {
        require(msg.sender == minter, "pair: not minter");
        IERC20(token).transfer(to, amount);
    }
}

/**
 * @title MockPancakeRouterV2
 * @notice Minimal Pancake V2 router surface used only for tests. Supports the
 *         two functions FypherLPVault actually calls:
 *
 *           addLiquidity(tokenA, tokenB, aDesired, bDesired, aMin, bMin, to, deadline)
 *           removeLiquidity(tokenA, tokenB, liquidity, aMin, bMin, to, deadline)
 *
 *         Reserve accounting is an internal sum — we do NOT replicate the
 *         xy=k pricing curve. That's fine because the vault never swaps; it
 *         only joins/exits the pair. Liquidity minted on add is simply
 *         (amountA + amountB) which keeps the assertions readable.
 *
 *         A `setSkim(num, den)` knob lets tests simulate the router
 *         consuming only a subset of each leg (mimics the way Pancake refuses
 *         to depeg the ratio when the caller-provided pair is lopsided). The
 *         vault relies on refunding the unused leftover on deposit — this
 *         knob exercises that branch.
 */
contract MockPancakeRouterV2 {
    using SafeERC20 for IERC20;

    MockPancakePair public immutable pair;
    address public immutable tokenA;
    address public immutable tokenB;

    uint256 public skimNum; // numerator; e.g. 9500 → use 95% of desired
    uint256 public skimDen = 10_000;

    constructor(MockPancakePair pair_, address tokenA_, address tokenB_) {
        pair = pair_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        skimNum = skimDen; // default = consume 100% (no skim)
    }

    function setSkim(uint256 num, uint256 den) external {
        require(den > 0 && num <= den, "bad skim");
        skimNum = num;
        skimDen = den;
    }

    function _reserveA() internal view returns (uint256) {
        return IERC20(tokenA).balanceOf(address(pair));
    }

    function _reserveB() internal view returns (uint256) {
        return IERC20(tokenB).balanceOf(address(pair));
    }

    function addLiquidity(
        address _tokenA,
        address _tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(block.timestamp <= deadline, "deadline");
        require(_tokenA == tokenA && _tokenB == tokenB, "token pair mismatch");

        amountA = (amountADesired * skimNum) / skimDen;
        amountB = (amountBDesired * skimNum) / skimDen;
        require(amountA >= amountAMin, "insufficient A");
        require(amountB >= amountBMin, "insufficient B");

        // Tokens flow straight into the pair, matching PCS V2 behaviour —
        // this lets {@code rusd.balanceOf(pair)} mirror the real reserves.
        IERC20(tokenA).safeTransferFrom(msg.sender, address(pair), amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(pair), amountB);

        liquidity = amountA + amountB;
        pair.mint(to, liquidity);
    }

    function removeLiquidity(
        address _tokenA,
        address _tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB) {
        require(block.timestamp <= deadline, "deadline");
        require(_tokenA == tokenA && _tokenB == tokenB, "token pair mismatch");

        uint256 supply = pair.totalSupply();
        require(supply > 0, "no liquidity");

        // Compute pre-burn to snapshot the reserves attributable to `liquidity`.
        amountA = (liquidity * _reserveA()) / supply;
        amountB = (liquidity * _reserveB()) / supply;
        require(amountA >= amountAMin, "insufficient A");
        require(amountB >= amountBMin, "insufficient B");

        pair.burn(msg.sender, liquidity);
        pair.pullTo(tokenA, to, amountA);
        pair.pullTo(tokenB, to, amountB);
    }
}
