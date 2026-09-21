#!/usr/bin/env node
/**
 * Exports a handful of real anchored decisions, with their inclusion proofs, for the verify page.
 *
 *   node scripts/export-samples.mjs <run-dump.json> web/samples.json
 *
 * The page ships with these so a visitor can verify something real on their first click, without
 * running a backtest first. They are ordinary decisions from the anchored batch — the proofs are
 * derived, not privileged, and anyone holding the run could regenerate them.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { keccak256, stringToBytes } from "viem";
import { buildMerkleTree, proofFor } from "../dist/merkle.js";

const [dumpPath, outPath = "web/samples.json"] = process.argv.slice(2);
if (!dumpPath) {
  console.error("usage: node scripts/export-samples.mjs <run-dump.json> [out.json]");
  process.exit(1);
}

const expand = (p) => (p.startsWith("~/") ? p.replace("~", homedir()) : p);

/** Stable key order, so a decision always hashes to the same leaf. Matches anchor-run.mjs. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(",")}}`;
}

const dump = JSON.parse(readFileSync(expand(dumpPath), "utf8"));
const decisions = dump.decisions ?? [];
const configHash = keccak256(stringToBytes(canonical(dump.params ?? {})));

const seen = new Set();
const unique = [];
const keptIndex = [];
decisions.forEach((d, i) => {
  const h = keccak256(stringToBytes(canonical(d)));
  if (seen.has(h)) return;
  seen.add(h);
  unique.push(h);
  keptIndex.push(i);
});

const tree = buildMerkleTree(unique);

// A spread across the batch and across verdicts, so the page is not all one kind of decision.
const wanted = ["buy", "hold", "avoid"];
const picks = [];
for (const verdict of wanted) {
  for (let n = 0; n < 2; n += 1) {
    const from = Math.floor((unique.length * (picks.length + 1)) / 8);
    const at = keptIndex.findIndex((orig, idx) => idx >= from && decisions[orig]?.verdict === verdict);
    if (at >= 0 && !picks.includes(at)) picks.push(at);
  }
}

const samples = picks.map((idx) => {
  const decision = decisions[keptIndex[idx]];
  return {
    label: `${decision.symbol} · ${String(decision.ts).slice(0, 10)}`,
    verdict: decision.verdict,
    category: decision.category,
    convictionScore: decision.convictionScore,
    decision,
    decisionHash: unique[idx],
    proof: proofFor(tree, idx),
  };
});

const out = {
  root: tree.root,
  configHash,
  decisionCount: unique.length,
  // The ERC-8004 agent that made these decisions, once one is registered. Null means the verify
  // page hides its identity panel rather than showing an unbound one; MONAD_AGENT_ID sets it, and
  // regenerating samples must not silently drop it.
  agentId: process.env.MONAD_AGENT_ID ? Number(process.env.MONAD_AGENT_ID) : null,
  generatedAt: new Date().toISOString(),
  samples,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`root ${tree.root}`);
console.log(`wrote ${samples.length} samples to ${outPath}`);
