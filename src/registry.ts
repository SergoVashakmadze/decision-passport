import type { Account, Address, Hex, PublicClient, WalletClient } from "viem";
import artifact from "./artifacts/DecisionRegistry.json" with { type: "json" };
import { buildMerkleTree, proofFor, verifyProof, type DecisionHash } from "./merkle.js";

export const DECISION_REGISTRY_ABI = artifact.abi;
export const DECISION_REGISTRY_BYTECODE = artifact.bytecode as Hex;

export interface AnchoredBatch {
  /** Merkle root of the batch; the identifier a decision is proved against. */
  root: Hex;
  txHash: Hex;
  blockNumber: bigint;
  decisionCount: number;
  /** Inclusion proof per decision, in the order the hashes were given. */
  proofs: Hex[][];
}

export interface MonadRegistryOptions {
  publicClient: PublicClient;
  address: Address;
}

export interface MonadAnchorerOptions extends MonadRegistryOptions {
  walletClient: WalletClient;
  account: Account;
}

/**
 * Reads the registry. Needs no wallet and no key: verification is meant to be something a sceptic
 * can do against a public RPC without asking us for anything.
 */
export class MonadVerifier {
  private readonly publicClient: PublicClient;
  private readonly address: Address;

  constructor({ publicClient, address }: MonadRegistryOptions) {
    this.publicClient = publicClient;
    this.address = address;
  }

  /** True once the batch root has been anchored. */
  async isAnchored(root: Hex): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: DECISION_REGISTRY_ABI,
      functionName: "isAnchored",
      args: [root],
    })) as boolean;
  }

  /**
   * Asks the chain whether this decision is in this batch. The same check runs locally in
   * `verifyProof`; doing it on chain additionally proves the root was anchored, and when it was.
   */
  async verifyDecision(root: Hex, decisionHash: DecisionHash, proof: readonly Hex[]): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: DECISION_REGISTRY_ABI,
      functionName: "verifyDecision",
      args: [root, decisionHash, proof],
    })) as boolean;
  }

  /** Batch metadata: the config that produced it, when it was anchored, by whom. */
  async batchInfo(root: Hex): Promise<{ configHash: Hex; anchoredAt: Date; decisionCount: number; anchoredBy: Address } | null> {
    const [configHash, anchoredAt, decisionCount, anchoredBy] = (await this.publicClient.readContract({
      address: this.address,
      abi: DECISION_REGISTRY_ABI,
      functionName: "batches",
      args: [root],
    })) as [Hex, bigint, number, Address];

    if (anchoredAt === 0n) return null;
    return { configHash, anchoredAt: new Date(Number(anchoredAt) * 1000), decisionCount, anchoredBy };
  }
}

/**
 * Writes batch roots. The private key never reaches this class: callers pass a viem account that
 * already holds it, so the key lives wherever the operator put it and not in our call graph.
 */
export class MonadAnchorer {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: Account;
  private readonly address: Address;

  constructor({ publicClient, walletClient, account, address }: MonadAnchorerOptions) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.account = account;
    this.address = address;
  }

  /**
   * Anchors a run: one transaction for the whole batch, and an inclusion proof per decision.
   *
   * The proofs are returned rather than stored on chain — they are derivable from the decision
   * hashes at any time, and storing them would put the thing being proved on chain alongside
   * the proof of it.
   */
  async anchorBatch(decisionHashes: readonly DecisionHash[], configHash: Hex): Promise<AnchoredBatch> {
    const tree = buildMerkleTree(decisionHashes);

    // Fails here rather than on chain if the root is already anchored, so the caller gets a clear
    // error instead of a reverted transaction and a spent fee.
    const verifier = new MonadVerifier({ publicClient: this.publicClient, address: this.address });
    if (await verifier.isAnchored(tree.root)) {
      throw new Error(`batch root ${tree.root} is already anchored`);
    }

    const txHash = await this.walletClient.writeContract({
      address: this.address,
      abi: DECISION_REGISTRY_ABI,
      functionName: "anchorBatch",
      args: [tree.root, configHash, decisionHashes.length],
      account: this.account,
      chain: this.walletClient.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`anchor transaction reverted: ${txHash}`);

    return {
      root: tree.root,
      txHash,
      blockNumber: receipt.blockNumber,
      decisionCount: decisionHashes.length,
      proofs: decisionHashes.map((_, i) => proofFor(tree, i)),
    };
  }

  /**
   * Anchors a single decision, as a one-leaf batch whose root is the leaf itself.
   *
   * This matches the shape of a one-decision-per-transaction anchorer, so callers written against
   * that shape can swap implementations. It is the expensive way to use this contract — a rebalance
   * should call `anchorBatch` once rather than this 500 times.
   */
  async anchor(decisionHash: DecisionHash, configHash: Hex): Promise<string> {
    const { txHash } = await this.anchorBatch([decisionHash], configHash);
    return txHash;
  }
}

/** Local, offline check. Re-exported here so callers need only this module for the common path. */
export { verifyProof };
