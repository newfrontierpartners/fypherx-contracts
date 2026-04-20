// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title FypherXInsuranceFundVault
 * @notice Holds an ERC-20 collateral buffer used by the clearinghouse to
 *         absorb liquidation deficits (bad debt) on the perpetual book.
 *
 * @dev April-audit M-9 patch. The previous shape held native ETH and
 *      received funds through `receive() external payable`. The
 *      clearinghouse, however, books collateral and PnL in an ERC-20
 *      collateral token (FYUSD / RUSD), so:
 *
 *        - the insurance fund could not actually be used to absorb a
 *          shortfall on a liquidation: the clearinghouse would have to
 *          swap ETH→ERC20 to credit the affected account, with no
 *          on-chain swap path, and
 *
 *        - any ETH credited to the vault was inert (no on-chain
 *          consumer), creating dead value that could only be reclaimed
 *          via the operator path.
 *
 *      Native receive remains explicitly disabled: the vault now only
 *      accepts the configured collateral ERC-20 via {deposit}.
 */
contract FypherXInsuranceFundVault {
    address public owner;
    IERC20Minimal public immutable token;
    mapping(address => bool) public operators;

    event OperatorUpdated(address indexed operator, bool allowed);
    event FundDeposited(address indexed from, uint256 amount, bytes32 referenceId);
    event FundWithdrawn(address indexed to, uint256 amount, bytes32 referenceId);
    event OwnerUpdated(address indexed previousOwner, address indexed nextOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOperator() {
        require(operators[msg.sender], "not operator");
        _;
    }

    constructor(address token_, address initialOperator) {
        require(token_ != address(0), "invalid token");
        owner = msg.sender;
        token = IERC20Minimal(token_);
        if (initialOperator != address(0)) {
            operators[initialOperator] = true;
            emit OperatorUpdated(initialOperator, true);
        }
        emit OwnerUpdated(address(0), msg.sender);
    }

    function setOwner(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "invalid owner");
        emit OwnerUpdated(owner, nextOwner);
        owner = nextOwner;
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    /**
     * @notice Pull `amount` of the vault token from `msg.sender` (caller
     *         must have approved this vault). The `referenceId` is
     *         emitted in the event so off-chain reconciliation can tie
     *         the deposit to the originating liquidation / surplus.
     */
    function deposit(uint256 amount, bytes32 referenceId) external {
        require(amount > 0, "invalid deposit");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit FundDeposited(msg.sender, amount, referenceId);
    }

    function withdraw(address to, uint256 amount, bytes32 referenceId) external onlyOperator {
        require(to != address(0), "invalid recipient");
        require(amount > 0, "invalid amount");
        require(token.balanceOf(address(this)) >= amount, "insufficient vault balance");
        require(token.transfer(to, amount), "withdraw failed");
        emit FundWithdrawn(to, amount, referenceId);
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
