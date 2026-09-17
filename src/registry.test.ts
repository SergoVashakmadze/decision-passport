import { describe, expect, it, vi } from "vitest";
import { encodePacked, keccak256, type Address, type Hex } from "viem";
import { MonadAnchorer, MonadVerifier, DECISION_REGISTRY_ABI, DECISION_REGISTRY_BYTECODE } from "./registry.js";
import { buildMerkleTree, proofFor } from "./merkle.js";

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const CONFIG_HASH = keccak256(encodePacked(["string"], ["strategy.lynch.json@v0.4.0"]));
const hashes = (n: number): Hex[] =>
  Array.from({ length: n }, (_, i) => keccak256(encodePacked(["string"], [`decision-${i}`])));

/** Minimal stand-ins: these assert what we send to the chain, not what the chain does with it. */
function publicClientStub(overrides: Record<string, unknown> = {}) {
  return {
    readContract: vi.fn().mockResolvedValue(false),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", blockNumber: 42n }),
    ...overrides,
  } as never;
}

function walletClientStub(txHash: Hex = "0xabc") {
  return { writeContract: vi.fn().mockResolvedValue(txHash), chain: undefined } as never;
}

const ACCOUNT_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const account = { address: ACCOUNT_ADDRESS } as never;

describe("MonadAnchorer", () => {
  it("anchors a batch in one transaction and returns a proof per decision", async () => {
    const decisions = hashes(500);
    const wallet = walletClientStub("0xfeed");
    const anchorer = new MonadAnchorer({ publicClient: publicClientStub(), walletClient: wallet, account, address: ADDRESS });

    const result = await anchorer.anchorBatch(decisions, CONFIG_HASH);

    // The whole point: 500 decisions, one transaction.
    expect((wallet as unknown as { writeContract: ReturnType<typeof vi.fn> }).writeContract).toHaveBeenCalledTimes(1);
    expect(result.decisionCount).toBe(500);
    expect(result.proofs).toHaveLength(500);
    expect(result.txHash).toBe("0xfeed");
    expect(result.blockNumber).toBe(42n);
    expect(result.root).toBe(buildMerkleTree(decisions).root);
  });

  it("sends the root, config hash and count the contract expects", async () => {
    const decisions = hashes(4);
    const wallet = walletClientStub();
    const anchorer = new MonadAnchorer({ publicClient: publicClientStub(), walletClient: wallet, account, address: ADDRESS });

    await anchorer.anchorBatch(decisions, CONFIG_HASH);

    const call = (wallet as unknown as { writeContract: ReturnType<typeof vi.fn> }).writeContract.mock.calls[0]![0];
    expect(call.functionName).toBe("anchorBatch");
    expect(call.args).toEqual([buildMerkleTree(decisions).root, CONFIG_HASH, 4]);
    expect(call.address).toBe(ADDRESS);
  });

  it("refuses to re-anchor a root before spending a fee on it", async () => {
    const publicClient = publicClientStub({ readContract: vi.fn().mockResolvedValue(true) });
    const wallet = walletClientStub();
    const anchorer = new MonadAnchorer({ publicClient, walletClient: wallet, account, address: ADDRESS });

    await expect(anchorer.anchorBatch(hashes(3), CONFIG_HASH)).rejects.toThrow(/already anchored/);
    expect((wallet as unknown as { writeContract: ReturnType<typeof vi.fn> }).writeContract).not.toHaveBeenCalled();
  });

  it("throws when the transaction reverts rather than reporting a successful anchor", async () => {
    const publicClient = publicClientStub({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted", blockNumber: 7n }),
    });
    const anchorer = new MonadAnchorer({ publicClient, walletClient: walletClientStub(), account, address: ADDRESS });

    await expect(anchorer.anchorBatch(hashes(2), CONFIG_HASH)).rejects.toThrow(/reverted/);
  });

  it("anchors a single decision as a one-leaf batch, matching the Algorand Anchorer shape", async () => {
    const [only] = hashes(1) as [Hex];
    const anchorer = new MonadAnchorer({ publicClient: publicClientStub(), walletClient: walletClientStub("0x01"), account, address: ADDRESS });

    expect(await anchorer.anchor(only, CONFIG_HASH)).toBe("0x01");
  });

  it("rejects an empty batch before touching the chain", async () => {
    const wallet = walletClientStub();
    const anchorer = new MonadAnchorer({ publicClient: publicClientStub(), walletClient: wallet, account, address: ADDRESS });

    await expect(anchorer.anchorBatch([], CONFIG_HASH)).rejects.toThrow(/empty batch/);
    expect((wallet as unknown as { writeContract: ReturnType<typeof vi.fn> }).writeContract).not.toHaveBeenCalled();
  });
});

describe("MonadVerifier", () => {
  it("passes the decision, proof and root straight to the contract", async () => {
    const decisions = hashes(8);
    const tree = buildMerkleTree(decisions);
    const proof = proofFor(tree, 5);
    const readContract = vi.fn().mockResolvedValue(true);
    const verifier = new MonadVerifier({ publicClient: publicClientStub({ readContract }), address: ADDRESS });

    expect(await verifier.verifyDecision(tree.root, decisions[5]!, proof)).toBe(true);
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      functionName: "verifyDecision",
      args: [tree.root, decisions[5], proof],
    });
  });

  it("reports an unanchored batch as null rather than an empty record", async () => {
    const readContract = vi.fn().mockResolvedValue(["0x00", 0n, 0, "0x0000000000000000000000000000000000000000"]);
    const verifier = new MonadVerifier({ publicClient: publicClientStub({ readContract }), address: ADDRESS });

    expect(await verifier.batchInfo("0xdead" as Hex)).toBeNull();
  });

  it("decodes batch metadata, turning the chain timestamp into a Date", async () => {
    const anchoredAt = 1_760_000_000n;
    const readContract = vi.fn().mockResolvedValue([CONFIG_HASH, anchoredAt, 500, ACCOUNT_ADDRESS]);
    const verifier = new MonadVerifier({ publicClient: publicClientStub({ readContract }), address: ADDRESS });

    const info = await verifier.batchInfo("0xbeef" as Hex);
    expect(info).not.toBeNull();
    expect(info!.configHash).toBe(CONFIG_HASH);
    expect(info!.decisionCount).toBe(500);
    expect(info!.anchoredAt.getTime()).toBe(Number(anchoredAt) * 1000);
  });
});

describe("compiled artifact", () => {
  it("ships an ABI and deployable bytecode", () => {
    expect(DECISION_REGISTRY_BYTECODE.startsWith("0x")).toBe(true);
    expect(DECISION_REGISTRY_BYTECODE.length).toBeGreaterThan(2);
    const names = DECISION_REGISTRY_ABI.filter((e) => e.type === "function").map((e) => (e as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(["anchorBatch", "verifyDecision", "isAnchored", "batches", "setAnchorer"]));
  });
});
