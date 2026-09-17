#!/usr/bin/env node
/**
 * Anchors a backtest run's decisions as one Merkle root on Monad, then proves one of them.
 *
 *   MONAD_DEPLOYER_KEY_FILE=./deployer.key \
 *   MONAD_REGISTRY_ADDRESS=0x... \
 *   node scripts/anchor-run.mjs ~/dipbuyer-runs/baseline-v040.json
 *
 * This is the end-to-end demonstration: tens of thousands of real decisions, one transaction, and
 * any single decision still provable against the chain afterwards.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, keccak256, toHex, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { buildMerkleTree, proofFor, verifyProof } from "../dist/merkle.js";
import { MonadAnchorer, MonadVerifier } from "../dist/registry.js";

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error("usage: node scripts/anchor-run.mjs <run-dump.json>");
  process.exit(1);
}

const expand = (p) => (p.startsWith("~/") ? p.replace("~", homedir()) : p);

/** Stable key order, so the same decision always hashes to the same leaf. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

const hashDecision = (decision) => keccak256(stringToBytes(canonical(decision)));

console.log(`reading ${dumpPath}…`);
const dump = JSON.parse(readFileSync(expand(dumpPath), "utf8"));
const decisions = dump.decisions ?? [];
if (decisions.length === 0) {
  console.error("no decisions in this dump");
  process.exit(1);
}

// The config that produced the run goes on chain with the root, so a verdict can never be
// re-read under a different set of rules than the ones that actually produced it.
const configHash = keccak256(stringToBytes(canonical(dump.params ?? {})));

console.log(`hashing ${decisions.length.toLocaleString()} decisions…`);
const t0 = Date.now();
const hashes = decisions.map(hashDecision);

// A duplicate leaf would let one proof stand for two positions, so collapse exact repeats. In a
// backtest the same (symbol, date, verdict) can legitimately recur across dumps; within one run it
// is a duplicate record, and keeping only the first is the honest reading.
const seen = new Set();
const unique = [];
const keptIndex = [];
hashes.forEach((h, i) => {
  if (seen.has(h)) return;
  seen.add(h);
  unique.push(h);
  keptIndex.push(i);
});
if (unique.length !== hashes.length) {
  console.log(`  ${hashes.length - unique.length} duplicate decision records dropped`);
}

const tree = buildMerkleTree(unique);
console.log(`  root ${tree.root}`);
console.log(`  built in ${((Date.now() - t0) / 1000).toFixed(1)}s, depth ${tree.levels.length - 1}`);

const network = process.env.MONAD_NETWORK === "mainnet" ? "mainnet" : "testnet";
const chain = network === "mainnet" ? monad : monadTestnet;
const address = process.env.MONAD_REGISTRY_ADDRESS;
if (!address) {
  console.error("MONAD_REGISTRY_ADDRESS is not set");
  process.exit(1);
}

const key = readFileSync(expand(process.env.MONAD_DEPLOYER_KEY_FILE ?? ""), "utf8").trim();
const account = privateKeyToAccount(key);
const transport = http(process.env.MONAD_RPC_URL || undefined);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

const anchorer = new MonadAnchorer({ publicClient, walletClient, account, address });
const verifier = new MonadVerifier({ publicClient, address });

console.log(`\nanchoring on ${chain.name}…`);
const batch = await anchorer.anchorBatch(unique, configHash);
console.log(`  tx    ${batch.txHash}`);
console.log(`  block ${batch.blockNumber}`);

// Prove a decision that was nowhere near the start or end of the batch.
const probe = Math.floor(unique.length / 3);
const decision = decisions[keptIndex[probe]];
const proof = proofFor(tree, probe);

console.log(`\nproving one decision: ${decision.symbol} on ${String(decision.ts).slice(0, 10)} (${decision.verdict})`);
console.log(`  proof is ${proof.length} hashes for a batch of ${unique.length.toLocaleString()}`);
console.log(`  locally  ${verifyProof(unique[probe], proof, tree.root)}`);
console.log(`  on chain ${await verifier.verifyDecision(tree.root, unique[probe], proof)}`);

// A decision that is not in the batch must fail, or the check proves nothing.
const outsider = keccak256(stringToBytes(canonical({ ...decision, verdict: "buy", tampered: true })));
console.log(`  tampered copy rejected: ${!(await verifier.verifyDecision(tree.root, outsider, proof))}`);

const info = await verifier.batchInfo(tree.root);
console.log(`\nbatch on chain: ${info.decisionCount.toLocaleString()} decisions, anchored ${info.anchoredAt.toISOString()}`);
console.log(`config hash   : ${info.configHash}`);
const explorer = chain.blockExplorers?.default?.url;
if (explorer) console.log(`explorer      : ${explorer}/tx/${batch.txHash}`);
