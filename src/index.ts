/**
 * Merkle-batched provenance for AI agent decisions on Monad.
 *
 * Anchoring one decision per transaction prices per-decision proof out of existence. This package anchors
 * a whole run as a single Merkle root, so a rebalance of ~500 decisions costs one transaction and
 * any individual decision is still provable with a ~9-hash inclusion proof.
 *
 * The decisions are then tied to the agent that made them through ERC-8004 agent identity, so the
 * chain records whose decisions they were and not only that they existed.
 */
export { buildMerkleTree, leafOf, proofFor, verifyProof } from "./merkle.js";
export type { DecisionHash, MerkleTree } from "./merkle.js";

export { MonadAnchorer, MonadVerifier, DECISION_REGISTRY_ABI, DECISION_REGISTRY_BYTECODE } from "./registry.js";
export type { AnchoredBatch, MonadAnchorerOptions, MonadRegistryOptions } from "./registry.js";

export {
  AgentIdentity,
  ERC8004_IDENTITY_ABI,
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_REPUTATION_REGISTRY,
  DECISION_REGISTRY_KEY,
  formatRegistryRef,
  parseRegistryRef,
  encodeRegistryRef,
} from "./identity.js";
export type { Agent, AgentIdentityOptions, RegistryRef } from "./identity.js";

export { decisionPassport } from "./passport.js";
export type { BindingCheck, DecisionCheck, Passport, PassportRequest } from "./passport.js";
