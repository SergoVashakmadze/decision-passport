import type { Address, Hex, PublicClient } from "viem";
import { hexToString, stringToHex } from "viem";

/**
 * ERC-8004 agent identity, read from the Monad registry.
 *
 * The decision registry proves a set of decisions existed under a named config. It does not say
 * whose decisions they were: all it records is the address that sent the anchoring transaction,
 * and an address is not an identity. ERC-8004 is where the identity lives — an ERC-721 whose token
 * id is the agent id, whose owner is the controlling key, and whose `agentURI` is the agent card.
 *
 * Binding the two takes both directions, because either alone is claimable by anyone:
 *   - the agent declares where its decisions are anchored (a `decisionRegistry` metadata entry on
 *     its own identity record, which only the agent can write);
 *   - the batch was anchored by a key the agent authorises (`isAuthorizedOrOwner`).
 *
 * The first without the second lets any address anchor into a registry the agent named. The second
 * without the first lets an agent's key anchor anywhere and have it read back as the agent's. Both
 * together are the claim: this agent says its decisions live here, and this batch was put here by
 * the agent's own key.
 */

/**
 * ERC-8004 registries on Monad. These are **mainnet-only** (chain 143) — verified as having no code
 * at the same addresses on testnet — so an agent's identity and its decision batches may well sit on
 * different chains. Nothing here assumes they share one; `AgentIdentity` takes its own client.
 */
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
export const ERC8004_REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address;

/** Metadata key under which an agent names the registry its decisions are anchored in. */
export const DECISION_REGISTRY_KEY = "decisionRegistry";

/**
 * The subset of the registry this package reads. Every entry was checked against the selectors in
 * the deployed implementation rather than taken from the specification, because the live contract
 * is an earlier revision than the current reference implementation: `getAgentWallet`, `totalAgents`
 * and `agentExists` are in the spec but are *not* in the deployed bytecode, and calling them would
 * revert. Reading identity through `isAuthorizedOrOwner` works on both revisions.
 */
export const ERC8004_IDENTITY_ABI = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "getMetadata", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }, { name: "key", type: "string" }], outputs: [{ type: "bytes" }] },
  { type: "function", name: "isAuthorizedOrOwner", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "agentId", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setMetadata", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "key", type: "string" }, { name: "value", type: "bytes" }], outputs: [] },
] as const;

export interface Agent {
  agentId: bigint;
  /** The key that controls the identity. */
  owner: Address;
  /** The agent card URI. Off-chain and mutable by the agent, so it proves nothing on its own. */
  agentURI: string;
}

/** A registry named in CAIP-10 form, e.g. `eip155:10143:0x9444…`. */
export interface RegistryRef {
  chainId: number;
  address: Address;
}

export interface AgentIdentityOptions {
  publicClient: PublicClient;
  /** Defaults to the ERC-8004 identity registry on Monad mainnet. */
  address?: Address;
}

const CAIP10_RE = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/;

/** CAIP-10 account id — the standard way to name a contract on a specific chain. */
export function formatRegistryRef({ chainId, address }: RegistryRef): string {
  return `eip155:${chainId}:${address.toLowerCase()}`;
}

/** Parses a CAIP-10 account id, returning null for anything that is not one. */
export function parseRegistryRef(value: string): RegistryRef | null {
  const match = CAIP10_RE.exec(value.trim());
  if (!match) return null;
  return { chainId: Number(match[1]), address: match[2]!.toLowerCase() as Address };
}

/** Encodes a registry reference for `setMetadata`, whose values are raw bytes. */
export function encodeRegistryRef(ref: RegistryRef): Hex {
  return stringToHex(formatRegistryRef(ref));
}

/**
 * Reads ERC-8004 agent identities. Read-only and wallet-free, like `MonadVerifier`: checking whose
 * agent anchored a batch should not require anything from the agent's operator.
 */
export class AgentIdentity {
  private readonly publicClient: PublicClient;
  readonly address: Address;

  constructor({ publicClient, address = ERC8004_IDENTITY_REGISTRY }: AgentIdentityOptions) {
    this.publicClient = publicClient;
    this.address = address;
  }

  /**
   * The agent record, or null if no such agent is registered.
   *
   * `ownerOf` reverts with `ERC721NonexistentToken` for an unregistered id rather than returning
   * the zero address, so an unknown agent surfaces here as null instead of an exception — the same
   * shape `MonadVerifier.batchInfo` uses for an unanchored root.
   */
  async agent(agentId: bigint): Promise<Agent | null> {
    try {
      const [owner, agentURI] = await Promise.all([
        this.publicClient.readContract({ address: this.address, abi: ERC8004_IDENTITY_ABI, functionName: "ownerOf", args: [agentId] }),
        this.publicClient.readContract({ address: this.address, abi: ERC8004_IDENTITY_ABI, functionName: "tokenURI", args: [agentId] }),
      ]);
      return { agentId, owner: owner as Address, agentURI: agentURI as string };
    } catch {
      return null;
    }
  }

  /**
   * Whether the agent authorises this address to act for it — its owner, or a wallet it has bound.
   *
   * This is the reverse half of the binding: it is what makes "agent 7 anchored this batch" mean
   * more than "someone wrote agent 7 in a file".
   */
  async isAuthorized(agentId: bigint, account: Address): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ERC8004_IDENTITY_ABI,
      functionName: "isAuthorizedOrOwner",
      args: [account, agentId],
    })) as boolean;
  }

  /** A raw metadata value, or null when the key is unset. */
  async metadata(agentId: bigint, key: string): Promise<Hex | null> {
    const value = (await this.publicClient.readContract({
      address: this.address,
      abi: ERC8004_IDENTITY_ABI,
      functionName: "getMetadata",
      args: [agentId, key],
    })) as Hex;
    return value && value !== "0x" ? value : null;
  }

  /**
   * The decision registry this agent declares as its own — the forward half of the binding.
   *
   * Returns null when the agent has not declared one, and also when it has declared something that
   * is not a CAIP-10 account id: a value we cannot parse is not a declaration, and reading it
   * loosely here would be the one place an unverified string could pass for a verified link.
   */
  async declaredRegistry(agentId: bigint): Promise<RegistryRef | null> {
    const raw = await this.metadata(agentId, DECISION_REGISTRY_KEY);
    if (raw === null) return null;
    try {
      return parseRegistryRef(hexToString(raw));
    } catch {
      return null;
    }
  }
}
