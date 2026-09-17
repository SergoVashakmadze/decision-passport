import { keccak256, encodePacked, type Hex } from "viem";

/**
 * Merkle batching for decision anchoring.
 *
 * A single rebalance produces one decision per screened company — roughly 500, and a ten-year
 * backtest dump holds ~53,000. Anchoring each one as its own transaction is what makes per-decision
 * proof impractical on most chains. Instead every decision hash in a run becomes a leaf, one root
 * is anchored, and any single decision is proved against that root with a log2(n) proof: ~9 hashes
 * for a 500-decision run.
 *
 * Layout is deliberately OpenZeppelin `MerkleProof`-compatible so the on-chain side is an audited
 * library rather than hand-written verification:
 *   - leaves are double-hashed, keccak256(keccak256(decisionHash)), so no internal node can be
 *     passed off as a leaf (second-preimage resistance);
 *   - sibling pairs are sorted before hashing, so a proof carries no direction bits;
 *   - an odd node at any level is promoted unchanged to the next level.
 */

/** A canonical hash of one decision record: 32 bytes, 0x-prefixed. */
export type DecisionHash = Hex;

export interface MerkleTree {
  root: Hex;
  /** Leaf hashes in tree order; index i corresponds to the i-th input decision hash. */
  leaves: Hex[];
  /** Every level, level 0 being the leaves and the last being `[root]`. */
  levels: Hex[][];
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** keccak256(keccak256(hash)) — the OpenZeppelin-recommended leaf encoding. */
export function leafOf(decisionHash: DecisionHash): Hex {
  if (!HASH_RE.test(decisionHash)) {
    throw new Error(`decision hash must be 0x + 64 hex chars, got: ${decisionHash}`);
  }
  return keccak256(keccak256(encodePacked(["bytes32"], [decisionHash as Hex])));
}

/** Sorted-pair parent hash; matches OpenZeppelin's `_hashPair`. */
function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(encodePacked(["bytes32", "bytes32"], [lo, hi]));
}

/**
 * Builds the tree over a run's decision hashes.
 *
 * Duplicate leaves are rejected rather than deduplicated: two identical leaves let one proof stand
 * for two different positions, and in a batch of decisions a duplicate means a bug upstream (the
 * same decision recorded twice), not something to paper over.
 */
export function buildMerkleTree(decisionHashes: readonly DecisionHash[]): MerkleTree {
  if (decisionHashes.length === 0) throw new Error("cannot anchor an empty batch");

  const leaves = decisionHashes.map(leafOf);
  const seen = new Set<string>();
  for (const leaf of leaves) {
    const key = leaf.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate decision hash in batch: ${leaf}`);
    seen.add(key);
  }

  const levels: Hex[][] = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      // An unpaired last node is promoted as-is rather than hashed with itself, which would
      // otherwise let it masquerade as its own parent.
      next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    }
    levels.push(next);
    level = next;
  }

  return { root: level[0]!, leaves, levels };
}

/** Sibling hashes proving the decision at `index` is in the tree, bottom level first. */
export function proofFor(tree: MerkleTree, index: number): Hex[] {
  if (!Number.isInteger(index) || index < 0 || index >= tree.leaves.length) {
    throw new Error(`leaf index ${index} out of range (0..${tree.leaves.length - 1})`);
  }
  const proof: Hex[] = [];
  let idx = index;
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const nodes = tree.levels[level]!;
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    // No sibling means this node was promoted unchanged, so nothing is added to the proof.
    if (siblingIdx < nodes.length) proof.push(nodes[siblingIdx]!);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Recomputes the root from a decision hash and its proof. This is the whole verification: it needs
 * no server, no indexer and no trust in us — only the root, which the chain holds.
 */
export function verifyProof(decisionHash: DecisionHash, proof: readonly Hex[], root: Hex): boolean {
  let computed = leafOf(decisionHash);
  for (const sibling of proof) computed = hashPair(computed, sibling);
  return computed.toLowerCase() === root.toLowerCase();
}
