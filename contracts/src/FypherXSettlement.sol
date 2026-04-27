// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FypherXSettlement
 * @notice Records canonical execution of off-chain matched trades. The
 *         on-chain entry is a one-shot per `tradeId` event so subsequent
 *         systems (risk, accounting, archival) have a tamper-resistant
 *         reference of what was matched off-chain.
 *
 * @dev April-audit H-5 patch. Previously `settleTrade` was protected
 *      only by an `onlyRelayer` allowlist. A single compromised relayer
 *      key (or a misbehaving operator) could therefore emit arbitrary
 *      `TradeSettled` events with no second signal of authenticity —
 *      every downstream system that trusts these events would happily
 *      ingest fabricated trades.
 *
 *      The new shape requires an EIP-712 signature from a separately
 *      managed `tradeSigner` key over the full set of trade fields.
 *      The relayer remains the on-chain transmitter (so it pays gas
 *      and is rate-limited by the allowlist), but compromise of the
 *      relayer alone is no longer enough to mint settlement events.
 */
contract FypherXSettlement {
    bytes32 public constant SETTLE_TYPEHASH = keccak256(
        "Settle(bytes32 tradeId,bytes32 marketId,bytes32 makerSubaccountId,bytes32 takerSubaccountId,uint256 priceE18,uint256 quantityE18,uint256 makerFeeE18,uint256 takerFeeE18,bytes32 payloadHash)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("FypherXSettlement"));
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    address public owner;
    /// @notice The off-chain signer whose key authorises trade settlement.
    /// @dev April-audit H-5. Distinct from the relayer keyset so that
    ///      compromise of one does not unilaterally cascade.
    address public tradeSigner;
    mapping(address => bool) public relayers;
    mapping(bytes32 => bool) public settledTrades;

    event RelayerUpdated(address indexed relayer, bool allowed);
    event TradeSignerUpdated(address indexed previousSigner, address indexed nextSigner);
    event OwnerUpdated(address indexed previousOwner, address indexed nextOwner);
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

    constructor(address initialRelayer, address initialSigner) {
        owner = msg.sender;
        emit OwnerUpdated(address(0), msg.sender);
        if (initialRelayer != address(0)) {
            relayers[initialRelayer] = true;
            emit RelayerUpdated(initialRelayer, true);
        }
        if (initialSigner != address(0)) {
            tradeSigner = initialSigner;
            emit TradeSignerUpdated(address(0), initialSigner);
        }
    }

    function setOwner(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "invalid owner");
        emit OwnerUpdated(owner, nextOwner);
        owner = nextOwner;
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        relayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setTradeSigner(address nextSigner) external onlyOwner {
        require(nextSigner != address(0), "invalid signer");
        emit TradeSignerUpdated(tradeSigner, nextSigner);
        tradeSigner = nextSigner;
    }

    /**
     * @notice Trade fields bundled into a struct. Avoids "stack too deep"
     *         while keeping the calldata layout inspectable on Etherscan.
     */
    struct Trade {
        bytes32 tradeId;
        bytes32 marketId;
        bytes32 makerSubaccountId;
        bytes32 takerSubaccountId;
        uint256 priceE18;
        uint256 quantityE18;
        uint256 makerFeeE18;
        uint256 takerFeeE18;
        bytes payload;
    }

    /**
     * @notice Record a settled trade. The relayer transmits; the
     *         {tradeSigner}'s EIP-712 signature authorises.
     *
     * @dev April-audit H-5 patch. Both keys are required.
     */
    function settleTrade(Trade calldata trade, bytes calldata signature) external onlyRelayer {
        require(!settledTrades[trade.tradeId], "trade already settled");
        require(tradeSigner != address(0), "signer unset");

        bytes32 d = _digest(trade);
        require(_recover(d, signature) == tradeSigner, "invalid signature");

        settledTrades[trade.tradeId] = true;

        emit TradeSettled(
            trade.tradeId,
            trade.marketId,
            trade.makerSubaccountId,
            trade.takerSubaccountId,
            trade.priceE18,
            trade.quantityE18,
            trade.makerFeeE18,
            trade.takerFeeE18,
            trade.payload
        );
    }

    /**
     * @notice Compute the EIP-712 digest a {tradeSigner} must sign for a
     *         given trade. Useful for off-chain signers/test harnesses.
     */
    function digest(Trade calldata trade) external view returns (bytes32) {
        return _digest(trade);
    }

    function _digest(Trade calldata trade) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SETTLE_TYPEHASH,
                trade.tradeId,
                trade.marketId,
                trade.makerSubaccountId,
                trade.takerSubaccountId,
                trade.priceE18,
                trade.quantityE18,
                trade.makerFeeE18,
                trade.takerFeeE18,
                keccak256(trade.payload)
            )
        );
        return keccak256(abi.encodePacked(hex"19_01", _domainSeparator(), structHash));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * @notice ECDSA recover with strict 65-byte (r,s,v) layout and
     *         malleability guard (s in lower half order).
     */
    function _recover(bytes32 hashed, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "invalid sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // EIP-2: low-s only
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "invalid s"
        );
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "invalid v");
        address recovered = ecrecover(hashed, v, r, s);
        require(recovered != address(0), "recover failed");
        return recovered;
    }
}
