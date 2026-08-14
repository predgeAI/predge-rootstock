// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  VerdictAnchor — every Predge verdict finalizes to Bitcoin
/// @notice Batches the hashes of a day's verdicts into a single merkle root and records that root
///         on Rootstock alongside a Bitcoin-L1 transaction id where the same root has been posted
///         (OP_RETURN). Rootstock is merge-mined by ~80% of Bitcoin hashrate; combined with a
///         daily Bitcoin-L1 anchor, every Predge verdict inherits Bitcoin final settlement.
///
///         Anyone can verify: (1) the on-chain event says the root existed on Rootstock at some
///         chain-timestamp; (2) the Bitcoin txid points to an OP_RETURN carrying the SAME root,
///         included in a Bitcoin block dated no later than a day after; (3) a specific verdict is
///         in that day's batch iff its merkle proof recomputes to the root. So a Predge verdict
///         cannot be silently altered without also altering a Bitcoin block — which is the
///         security floor of Bitcoin itself.
///
/// @dev    We don't verify SPV proofs on-chain here; the Bitcoin txid is committed on Rootstock
///         and verifiable off-chain. That's enough to make forgery require rewriting Bitcoin.
///         Deliberately minimal: append-only, owner-rotatable anchorer, no delete, no upgrade.
contract VerdictAnchor {
    struct Anchor {
        bytes32 merkleRoot;   // root of the batched verdict hashes
        uint32  count;        // number of verdicts in the batch
        uint64  rskCommittedAt; // Rootstock timestamp when the root was recorded here
        uint64  btcAnchoredAt;  // Bitcoin block time of the OP_RETURN, filled once known
        bytes32 btcTxid;      // Bitcoin L1 txid of the OP_RETURN carrying merkleRoot
        uint32  btcBlockHeight;
    }

    address public owner;
    address public anchorer; // the address allowed to record roots and Bitcoin proofs

    uint64 public totalBatches;
    mapping(uint64 => Anchor) public batchOf;   // batchId → Anchor
    mapping(bytes32 => uint64) public batchIdOfRoot; // root → batchId

    event RootCommitted(uint64 indexed batchId, bytes32 indexed merkleRoot, uint32 count, uint64 rskCommittedAt);
    event BtcAnchored(uint64 indexed batchId, bytes32 indexed btcTxid, uint32 btcBlockHeight, uint64 btcAnchoredAt);
    event AnchorerUpdated(address indexed previousAnchorer, address indexed newAnchorer);

    error NotOwner();
    error NotAnchorer();
    error ZeroAddress();
    error ZeroRoot();
    error UnknownBatch();
    error AlreadyAnchored();
    error DuplicateRoot();

    modifier onlyOwner()    { if (msg.sender != owner)    revert NotOwner();    _; }
    modifier onlyAnchorer() { if (msg.sender != anchorer) revert NotAnchorer(); _; }

    constructor(address anchorer_) {
        if (anchorer_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        anchorer = anchorer_;
    }

    /// @notice Record a batch's merkle root on Rootstock. Post-condition: the root is timestamped
    ///         by the chain, so no matter when the Bitcoin anchor lands, the "committed here first"
    ///         property is provable. Reverts on duplicate root — each daily batch has a unique root.
    function commitRoot(bytes32 merkleRoot, uint32 count) external onlyAnchorer returns (uint64 batchId) {
        if (merkleRoot == bytes32(0)) revert ZeroRoot();
        if (batchIdOfRoot[merkleRoot] != 0) revert DuplicateRoot();
        batchId = ++totalBatches;
        batchOf[batchId] = Anchor({
            merkleRoot: merkleRoot,
            count: count,
            rskCommittedAt: uint64(block.timestamp),
            btcAnchoredAt: 0,
            btcTxid: bytes32(0),
            btcBlockHeight: 0
        });
        batchIdOfRoot[merkleRoot] = batchId;
        emit RootCommitted(batchId, merkleRoot, count, uint64(block.timestamp));
    }

    /// @notice Record the Bitcoin L1 anchor for a batch. Callable once per batch — we can't rewrite
    ///         history if a reorg claims a different txid; you'd need a new batch instead.
    function recordBtcAnchor(uint64 batchId, bytes32 btcTxid, uint32 btcBlockHeight, uint64 btcAnchoredAt)
        external
        onlyAnchorer
    {
        Anchor storage a = batchOf[batchId];
        if (a.rskCommittedAt == 0) revert UnknownBatch();
        if (a.btcTxid != bytes32(0)) revert AlreadyAnchored();
        a.btcTxid = btcTxid;
        a.btcBlockHeight = btcBlockHeight;
        a.btcAnchoredAt = btcAnchoredAt;
        emit BtcAnchored(batchId, btcTxid, btcBlockHeight, btcAnchoredAt);
    }

    function setAnchorer(address newAnchorer) external onlyOwner {
        if (newAnchorer == address(0)) revert ZeroAddress();
        emit AnchorerUpdated(anchorer, newAnchorer);
        anchorer = newAnchorer;
    }
}
