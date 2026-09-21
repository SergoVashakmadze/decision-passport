import type { Address, Hex } from "viem";
import type { AgentIdentity, Agent, RegistryRef } from "./identity.js";
import { formatRegistryRef } from "./identity.js";
import type { MonadVerifier } from "./registry.js";
import { verifyProof, type DecisionHash } from "./merkle.js";

/**
 * The passport: one decision, tied to the batch it belongs to, tied to the agent that made it.
 *
 * Each link is checked against a chain rather than asserted:
 *   decision → batch     inclusion proof against the anchored root
 *   batch    → anchorer  the decision registry records who anchored it
 *   anchorer → agent     the ERC-8004 registry says the agent authorises that key
 *   agent    → registry  the agent's own identity record names this registry
 *
 * Any link that fails leaves the others standing, which is the point of reporting them separately:
 * a batch with a valid inclusion proof and a broken identity binding is still an anchored batch,
 * and saying so is more useful than a single false.
 */

export interface BindingCheck {
  /** The agent's identity record names this decision registry. */
  registryDeclared: boolean;
  /** What it names, if anything — present even when it names a different registry. */
  declaredRegistry: RegistryRef | null;
  /** The batch's anchorer is a key the agent authorises. */
  anchorerAuthorized: boolean;
  /** Both directions hold. Neither alone is enough; see `identity.ts`. */
  bound: boolean;
}

export interface DecisionCheck {
  decisionHash: DecisionHash;
  /** Recomputed from the proof, offline. */
  includedLocally: boolean;
  /** The same check run by the contract, which additionally proves the root was anchored. */
  includedOnChain: boolean;
}

export interface Passport {
  batch: {
    root: Hex;
    configHash: Hex;
    anchoredAt: Date;
    decisionCount: number;
    anchoredBy: Address;
  } | null;
  agent: Agent | null;
  binding: BindingCheck;
  decision: DecisionCheck | null;
}

export interface PassportRequest {
  verifier: MonadVerifier;
  identity: AgentIdentity;
  /** The chain the decision registry is deployed on — 10143 for Monad testnet, 143 for mainnet. */
  registry: RegistryRef;
  root: Hex;
  agentId: bigint;
  /** Optional: the one decision to prove, with its inclusion proof. */
  decisionHash?: DecisionHash;
  proof?: readonly Hex[];
}

const UNBOUND: BindingCheck = {
  registryDeclared: false,
  declaredRegistry: null,
  anchorerAuthorized: false,
  bound: false,
};

/**
 * Assembles a passport by reading both chains. Read-only throughout: no wallet, no key, nothing
 * asked of the agent's operator.
 *
 * The identity registry lives on Monad mainnet while a batch may be anchored on testnet, so the two
 * reads go through separate clients and the binding is a statement about a key controlling both
 * records — not something either chain attests on its own.
 */
export async function decisionPassport(request: PassportRequest): Promise<Passport> {
  const { verifier, identity, registry, root, agentId, decisionHash, proof } = request;

  const [info, agent] = await Promise.all([verifier.batchInfo(root), identity.agent(agentId)]);
  // The root is what a batch is called everywhere else, so it travels with the record rather
  // than only being the key it was looked up by.
  const batch = info && { root, ...info };

  const decision =
    decisionHash && proof
      ? {
          decisionHash,
          includedLocally: verifyProof(decisionHash, proof, root),
          includedOnChain: await verifier.verifyDecision(root, decisionHash, proof),
        }
      : null;

  // An unanchored root or an unregistered agent leaves nothing to bind: there is no anchorer to
  // authorise. Reporting that as an unmet binding is honest; skipping the reads avoids asking the
  // identity registry about the zero address.
  if (!batch || !agent) return { batch, agent, binding: { ...UNBOUND }, decision };

  const [declaredRegistry, anchorerAuthorized] = await Promise.all([
    identity.declaredRegistry(agentId),
    identity.isAuthorized(agentId, batch.anchoredBy),
  ]);

  const registryDeclared =
    declaredRegistry !== null && formatRegistryRef(declaredRegistry) === formatRegistryRef(registry);

  return {
    batch,
    agent,
    binding: {
      registryDeclared,
      declaredRegistry,
      anchorerAuthorized,
      bound: registryDeclared && anchorerAuthorized,
    },
    decision,
  };
}
