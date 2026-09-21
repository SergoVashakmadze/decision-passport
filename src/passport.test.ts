import { describe, expect, it, vi } from "vitest";
import { encodePacked, keccak256, stringToHex, type Address, type Hex } from "viem";
import { AgentIdentity } from "./identity.js";
import { MonadVerifier } from "./registry.js";
import { decisionPassport } from "./passport.js";
import { buildMerkleTree, proofFor } from "./merkle.js";

const REGISTRY = "0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121" as Address;
const ANCHORER = "0x8dF64bACf6b70F7787f8d14429b258B3fF958ec1" as Address;
const STRANGER = "0x1111111111111111111111111111111111111111" as Address;
const CONFIG_HASH = keccak256(encodePacked(["string"], ["strategy.lynch.json@v0.4.0"]));
const TESTNET = { chainId: 10143, address: REGISTRY };

const decisions: Hex[] = Array.from({ length: 16 }, (_, i) =>
  keccak256(encodePacked(["string"], [`decision-${i}`])),
);
const tree = buildMerkleTree(decisions);
const proof = proofFor(tree, 5);

interface ChainState {
  anchoredBy?: Address;
  anchored?: boolean;
  owner?: Address | null;
  declared?: string | null;
  authorized?: boolean;
  included?: boolean;
}

/** Both chains as a single set of facts, so a test reads as a scenario rather than as plumbing. */
function passportFor(state: ChainState, decision?: { decisionHash: Hex; proof: readonly Hex[] }) {
  const {
    anchoredBy = ANCHORER,
    anchored = true,
    owner = ANCHORER,
    declared = `eip155:10143:${REGISTRY}`,
    authorized = true,
    included = true,
  } = state;

  const decisionClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "batches") {
        return anchored ? [CONFIG_HASH, 1_760_000_000n, decisions.length, anchoredBy] : ["0x00", 0n, 0, STRANGER];
      }
      return included;
    }),
  } as never;

  const identityClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "ownerOf") {
        if (owner === null) throw new Error("ERC721NonexistentToken(9)");
        return owner;
      }
      if (functionName === "tokenURI") return "https://example.test/agent-card.json";
      if (functionName === "getMetadata") return declared === null ? "0x" : stringToHex(declared);
      return authorized;
    }),
  } as never;

  return decisionPassport({
    verifier: new MonadVerifier({ publicClient: decisionClient, address: REGISTRY }),
    identity: new AgentIdentity({ publicClient: identityClient }),
    registry: TESTNET,
    root: tree.root,
    agentId: 2n,
    ...decision,
  });
}

describe("decisionPassport", () => {
  it("binds a batch to its agent when the agent named the registry and authorises the anchorer", async () => {
    const passport = await passportFor({});

    expect(passport.batch?.root).toBe(tree.root);
    expect(passport.batch?.anchoredBy).toBe(ANCHORER);
    expect(passport.agent?.owner).toBe(ANCHORER);
    expect(passport.binding).toMatchObject({
      registryDeclared: true,
      anchorerAuthorized: true,
      bound: true,
    });
  });

  it("refuses the binding when the agent names a different registry", async () => {
    // Otherwise any address could anchor into a registry and read the batch back as the agent's.
    const passport = await passportFor({ declared: "eip155:10143:0x2222222222222222222222222222222222222222" });

    expect(passport.binding.registryDeclared).toBe(false);
    expect(passport.binding.declaredRegistry?.address).toBe("0x2222222222222222222222222222222222222222");
    expect(passport.binding.bound).toBe(false);
  });

  it("refuses the binding when the agent names the right address on the wrong chain", async () => {
    const passport = await passportFor({ declared: `eip155:143:${REGISTRY}` });

    expect(passport.binding.registryDeclared).toBe(false);
    expect(passport.binding.bound).toBe(false);
  });

  it("refuses the binding when the anchorer is not a key the agent authorises", async () => {
    const passport = await passportFor({ anchoredBy: STRANGER, authorized: false });

    expect(passport.binding.registryDeclared).toBe(true);
    expect(passport.binding.anchorerAuthorized).toBe(false);
    expect(passport.binding.bound).toBe(false);
  });

  it("checks authorisation against the address that actually anchored, not the agent's owner", async () => {
    const identityRead = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "ownerOf" ? ANCHORER
        : functionName === "tokenURI" ? ""
        : functionName === "getMetadata" ? stringToHex(`eip155:10143:${REGISTRY}`)
        : true,
    );
    const decisionRead = vi.fn(async () => [CONFIG_HASH, 1_760_000_000n, 16, STRANGER]);

    await decisionPassport({
      verifier: new MonadVerifier({ publicClient: { readContract: decisionRead } as never, address: REGISTRY }),
      identity: new AgentIdentity({ publicClient: { readContract: identityRead } as never }),
      registry: TESTNET,
      root: tree.root,
      agentId: 2n,
    });

    const authCall = identityRead.mock.calls.find((c) => c[0].functionName === "isAuthorizedOrOwner");
    expect(authCall![0]).toMatchObject({ args: [STRANGER, 2n] });
  });

  it("reports an unanchored root as an unmet binding without asking the identity registry about it", async () => {
    const passport = await passportFor({ anchored: false });

    expect(passport.batch).toBeNull();
    expect(passport.binding.bound).toBe(false);
    expect(passport.binding.anchorerAuthorized).toBe(false);
  });

  it("reports an unregistered agent as null while leaving the batch standing", async () => {
    const passport = await passportFor({ owner: null });

    expect(passport.agent).toBeNull();
    expect(passport.batch?.root).toBe(tree.root);
    expect(passport.binding.bound).toBe(false);
  });

  it("proves one decision against the batch, locally and on chain", async () => {
    const passport = await passportFor({}, { decisionHash: decisions[5]!, proof });

    expect(passport.decision).toMatchObject({
      decisionHash: decisions[5],
      includedLocally: true,
      includedOnChain: true,
    });
  });

  it("rejects a tampered decision locally even when the chain is asked about a different one", async () => {
    const tampered = keccak256(encodePacked(["string"], ["decision-5-tampered"]));
    const passport = await passportFor({ included: false }, { decisionHash: tampered, proof });

    expect(passport.decision?.includedLocally).toBe(false);
    expect(passport.decision?.includedOnChain).toBe(false);
    // A failed inclusion check says nothing about who the agent is; the binding still holds.
    expect(passport.binding.bound).toBe(true);
  });

  it("omits the decision check when no decision was given", async () => {
    expect((await passportFor({})).decision).toBeNull();
  });
});
