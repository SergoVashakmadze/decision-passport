import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, encodePacked, type Hex } from "viem";
import { buildMerkleTree, leafOf, proofFor, verifyProof } from "./merkle.js";

/** Deterministic stand-ins for `hashDecision` output. */
const hashes = (n: number): Hex[] =>
  Array.from({ length: n }, (_, i) => keccak256(encodePacked(["string"], [`decision-${i}`])));

describe("merkle batching", () => {
  it("proves every leaf in trees of awkward sizes", () => {
    // 1 is the degenerate case; 3, 5 and 7 each promote an unpaired node at a different level.
    for (const size of [1, 2, 3, 5, 7, 8, 500]) {
      const decisions = hashes(size);
      const tree = buildMerkleTree(decisions);
      for (let i = 0; i < size; i += 1) {
        expect(verifyProof(decisions[i]!, proofFor(tree, i), tree.root), `size ${size}, leaf ${i}`).toBe(true);
      }
    }
  });

  it("rejects a decision that is not in the batch", () => {
    const decisions = hashes(16);
    const tree = buildMerkleTree(decisions);
    const outsider = keccak256(encodePacked(["string"], ["never-happened"]));
    expect(verifyProof(outsider, proofFor(tree, 0), tree.root)).toBe(false);
  });

  it("rejects a proof borrowed from another leaf", () => {
    const decisions = hashes(16);
    const tree = buildMerkleTree(decisions);
    expect(verifyProof(decisions[3]!, proofFor(tree, 9), tree.root)).toBe(false);
  });

  it("rejects a tampered proof element", () => {
    const decisions = hashes(8);
    const tree = buildMerkleTree(decisions);
    const proof = proofFor(tree, 2);
    proof[0] = keccak256(encodePacked(["string"], ["tampered"]));
    expect(verifyProof(decisions[2]!, proof, tree.root)).toBe(false);
  });

  it("will not let an internal node pass as a leaf", () => {
    // The reason leaves are double-hashed: without it, a caller could present the parent of two
    // real leaves as though it were a decision of its own.
    const decisions = hashes(4);
    const tree = buildMerkleTree(decisions);
    const internal = tree.levels[1]![0]!;
    expect(verifyProof(internal, [tree.levels[1]![1]!], tree.root)).toBe(false);
  });

  it("is order-independent for a pair, because siblings are sorted", () => {
    const [a, b] = hashes(2) as [Hex, Hex];
    expect(buildMerkleTree([a, b]).root).toBe(buildMerkleTree([b, a]).root);
  });

  it("changes the root when any decision changes", () => {
    const decisions = hashes(32);
    const before = buildMerkleTree(decisions).root;
    const after = buildMerkleTree([...decisions.slice(0, 17), keccak256(encodePacked(["string"], ["edited"])), ...decisions.slice(18)]).root;
    expect(after).not.toBe(before);
  });

  it("refuses an empty batch and duplicate decisions", () => {
    expect(() => buildMerkleTree([])).toThrow(/empty batch/);
    const [a] = hashes(1) as [Hex];
    expect(() => buildMerkleTree([a, a])).toThrow(/duplicate/);
  });

  it("refuses a malformed decision hash", () => {
    expect(() => leafOf("0xdeadbeef" as Hex)).toThrow(/64 hex/);
  });

  it("refuses an out-of-range leaf index", () => {
    const tree = buildMerkleTree(hashes(4));
    expect(() => proofFor(tree, 4)).toThrow(/out of range/);
    expect(() => proofFor(tree, -1)).toThrow(/out of range/);
  });

  it("encodes leaves and pairs exactly as DecisionRegistry.sol does", () => {
    // The contract uses abi.encode; this file uses encodePacked. For bytes32 arguments the two are
    // byte-identical, and this test is what keeps that true: if it ever fails, valid proofs would
    // be rejected on chain while passing locally, which is the worst possible failure here.
    const [decision, sibling] = hashes(2) as [Hex, Hex];

    const solidityLeaf = keccak256(
      encodeAbiParameters([{ type: "bytes32" }], [keccak256(encodeAbiParameters([{ type: "bytes32" }], [decision]))]),
    );
    expect(leafOf(decision)).toBe(solidityLeaf);

    const [lo, hi] = solidityLeaf.toLowerCase() <= sibling.toLowerCase() ? [solidityLeaf, sibling] : [sibling, solidityLeaf];
    const solidityPair = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [lo, hi]));
    const tsPair = keccak256(encodePacked(["bytes32", "bytes32"], [lo, hi]));
    expect(tsPair).toBe(solidityPair);
  });

  it("keeps proofs logarithmic, which is the point of batching", () => {
    const tree = buildMerkleTree(hashes(512));
    expect(proofFor(tree, 0)).toHaveLength(9);
  });
});
