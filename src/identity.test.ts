import { describe, expect, it, vi } from "vitest";
import { stringToHex, type Address } from "viem";
import {
  AgentIdentity,
  DECISION_REGISTRY_KEY,
  ERC8004_IDENTITY_REGISTRY,
  encodeRegistryRef,
  formatRegistryRef,
  parseRegistryRef,
} from "./identity.js";

const OWNER = "0x8dF64bACf6b70F7787f8d14429b258B3fF958ec1" as Address;
const REGISTRY = "0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121" as Address;

/** Answers by function name, so a test states what the chain says rather than call ordering. */
function identityStub(answers: Record<string, unknown>) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    const answer = answers[functionName];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { client: { readContract } as never, readContract };
}

describe("registry references", () => {
  it("round-trips through CAIP-10", () => {
    const ref = { chainId: 10143, address: REGISTRY };
    expect(formatRegistryRef(ref)).toBe(`eip155:10143:${REGISTRY}`);
    expect(parseRegistryRef(formatRegistryRef(ref))).toEqual(ref);
  });

  it("lower-cases the address so a checksummed and an unchecksummed reference compare equal", () => {
    const upper = parseRegistryRef("eip155:10143:0x9444AD8EAA2B17FC725827AB4CC8A73725DD7121");
    expect(upper).toEqual({ chainId: 10143, address: REGISTRY });
  });

  it("rejects anything that is not a CAIP-10 account id", () => {
    for (const value of [REGISTRY, "eip155:10143", "eip155:10143:0xshort", "solana:x:y", ""]) {
      expect(parseRegistryRef(value)).toBeNull();
    }
  });

  it("encodes for setMetadata as UTF-8 bytes", () => {
    expect(encodeRegistryRef({ chainId: 143, address: REGISTRY })).toBe(stringToHex(`eip155:143:${REGISTRY}`));
  });
});

describe("AgentIdentity", () => {
  it("defaults to the ERC-8004 registry on Monad mainnet", () => {
    const { client } = identityStub({});
    expect(new AgentIdentity({ publicClient: client }).address).toBe(ERC8004_IDENTITY_REGISTRY);
  });

  it("reads an agent's owner and card URI", async () => {
    const { client } = identityStub({ ownerOf: OWNER, tokenURI: "https://example.test/agent-card.json" });
    const agent = await new AgentIdentity({ publicClient: client }).agent(2n);

    expect(agent).toEqual({ agentId: 2n, owner: OWNER, agentURI: "https://example.test/agent-card.json" });
  });

  it("reports an unregistered agent as null rather than throwing", async () => {
    // The live registry reverts with ERC721NonexistentToken instead of returning the zero address.
    const { client } = identityStub({ ownerOf: new Error("ERC721NonexistentToken(7)"), tokenURI: "" });

    expect(await new AgentIdentity({ publicClient: client }).agent(7n)).toBeNull();
  });

  it("asks the registry whether an address may act for the agent", async () => {
    const { client, readContract } = identityStub({ isAuthorizedOrOwner: true });

    expect(await new AgentIdentity({ publicClient: client }).isAuthorized(2n, OWNER)).toBe(true);
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      functionName: "isAuthorizedOrOwner",
      args: [OWNER, 2n],
    });
  });

  it("reads the declared decision registry from agent metadata", async () => {
    const { client, readContract } = identityStub({ getMetadata: stringToHex(`eip155:10143:${REGISTRY}`) });

    const declared = await new AgentIdentity({ publicClient: client }).declaredRegistry(2n);

    expect(declared).toEqual({ chainId: 10143, address: REGISTRY });
    expect(readContract.mock.calls[0]![0]).toMatchObject({ args: [2n, DECISION_REGISTRY_KEY] });
  });

  it("treats an unset key as no declaration", async () => {
    const { client } = identityStub({ getMetadata: "0x" });
    expect(await new AgentIdentity({ publicClient: client }).declaredRegistry(2n)).toBeNull();
  });

  it("refuses to read a declaration out of a value that is not a CAIP-10 id", async () => {
    // A loose read here is the one place an unverified string could pass for a verified link.
    const { client } = identityStub({ getMetadata: stringToHex("trust me, it is 0x9444…") });
    expect(await new AgentIdentity({ publicClient: client }).declaredRegistry(2n)).toBeNull();
  });
});
