// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title DecisionRegistry
 * @notice Anchors the Merkle root of a batch of AI agent decisions.
 *
 * What goes on chain is one 32-byte root per run, plus the hash of the strategy config that
 * produced it. Nothing else — no company data, no holdings, no personal data. The decision
 * records themselves stay off chain; this contract proves only that a given set of decisions
 * existed, unchanged, at a given block, under a named version of the rules.
 *
 * It deliberately proves nothing about whether the decisions were any good.
 */
contract DecisionRegistry {
    struct Batch {
        bytes32 configHash;
        uint64 anchoredAt;
        uint32 decisionCount;
        address anchoredBy;
    }

    /// @notice Batch metadata by Merkle root. A root is anchored at most once.
    mapping(bytes32 => Batch) public batches;

    /// @notice Addresses permitted to anchor. The owner is the only one who can change the set.
    mapping(address => bool) public anchorers;

    address public owner;

    event BatchAnchored(
        bytes32 indexed root,
        bytes32 indexed configHash,
        uint32 decisionCount,
        address indexed anchoredBy,
        uint64 anchoredAt
    );
    event AnchorerSet(address indexed account, bool allowed);
    event OwnerTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotAnchorer();
    error AlreadyAnchored(bytes32 root);
    error EmptyBatch();
    error ZeroRoot();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        anchorers[msg.sender] = true;
        emit OwnerTransferred(address(0), msg.sender);
        emit AnchorerSet(msg.sender, true);
    }

    /**
     * @notice Records a batch root.
     * @param root Merkle root over the run's decision hashes (sorted-pair, double-hashed leaves).
     * @param configHash Hash of the strategy config version that produced the decisions.
     * @param decisionCount Number of decisions in the batch, for display and sanity checks only.
     *
     * Re-anchoring a root is rejected so the first anchor time is the one that stands; otherwise a
     * later write could quietly move a batch's timestamp forward.
     */
    function anchorBatch(bytes32 root, bytes32 configHash, uint32 decisionCount) external {
        if (!anchorers[msg.sender]) revert NotAnchorer();
        if (root == bytes32(0)) revert ZeroRoot();
        if (decisionCount == 0) revert EmptyBatch();
        if (batches[root].anchoredAt != 0) revert AlreadyAnchored(root);

        batches[root] = Batch({
            configHash: configHash,
            anchoredAt: uint64(block.timestamp),
            decisionCount: decisionCount,
            anchoredBy: msg.sender
        });

        emit BatchAnchored(root, configHash, decisionCount, msg.sender, uint64(block.timestamp));
    }

    /// @notice True once `root` has been anchored.
    function isAnchored(bytes32 root) external view returns (bool) {
        return batches[root].anchoredAt != 0;
    }

    /**
     * @notice Verifies that `decisionHash` belongs to the anchored batch `root`.
     * @dev Leaf encoding and pair ordering match OpenZeppelin `MerkleProof`, and the TypeScript
     *      builder in `src/merkle.ts`. Returns false for an unanchored root rather than reverting,
     *      so a caller can tell "not in this batch" from "batch does not exist" via `isAnchored`.
     */
    function verifyDecision(bytes32 root, bytes32 decisionHash, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        if (batches[root].anchoredAt == 0) return false;

        bytes32 computed = keccak256(abi.encode(keccak256(abi.encode(decisionHash))));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed <= sibling
                ? keccak256(abi.encode(computed, sibling))
                : keccak256(abi.encode(sibling, computed));
        }
        return computed == root;
    }

    function setAnchorer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        anchorers[account] = allowed;
        emit AnchorerSet(account, allowed);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, to);
        owner = to;
    }
}
