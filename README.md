# Decision Passport

**Merkle-batched provenance for AI agent decisions, anchored on Monad.**

Built for [Monad Metropolis](https://monad.xyz/developers/hackathons/metropolis) — Trust, Identity &
AI Infrastructure.

An AI agent that makes consequential decisions should be able to prove, later, what it decided, when,
and under which version of its rules. Not "trust our logs" — prove it, to someone who does not trust
the operator and should not have to.

This is the provenance layer for [DipBuyer AI](https://dipbuyer.ai), a value-investing agent whose
verdicts come from deterministic, versioned rules rather than a language model. The mechanism is
general: it works for any agent producing a stream of decisions you might later be asked to justify.

## The problem with anchoring decisions

The obvious design is one decision, one transaction. It does not survive contact with a real agent.

A single portfolio rebalance screens ~500 companies. A ten-year backtest holds **53,384** decision
records. At one transaction each, per-decision proof is priced out of existence — which is why most
"on-chain AI provenance" stops at anchoring a daily summary hash, and a summary hash cannot prove
anything about an individual decision.

## What this does instead

Every decision in a run becomes a leaf in a Merkle tree. **One root is anchored per run.** Any single
decision is then provable against that root with a `log₂(n)` inclusion proof — about 16 hashes for a
batch of 53,384 — verifiable by anyone against a public RPC, with no server and no trust in us.

Only the root, the hash of the config that produced the run, and a count go on chain. No company
data, no holdings, no personal data. The chain proves a set of decisions existed, unchanged, at a
given block, under a named version of the rules.

It deliberately proves nothing about whether those decisions were any good.

## Live on Monad testnet

| | |
|---|---|
| `DecisionRegistry` | [`0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121`](https://testnet.monadexplorer.com/address/0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121) |
| Chain | Monad Testnet (10143) |
| Deploy gas | 534,375 |

A real backtest run — **53,384 decisions from a 2016-2025 S&P 500 strategy** — anchored as a single
transaction, then one decision proved against it:

```
root   0x9b361f4620dda3d51aa6c3806928e52a981970c0740594bde912d8e5f3e6e911
tx     0xdb6f1f19d37f37428996492332f92eab12aec7982ac9abf8ba4bdaf1d799443f
depth  16

proving one decision: NWL on 2019-05-19 (avoid)
  proof is 16 hashes for a batch of 53,384
  locally  true
  on chain true
  tampered copy rejected: true
```

[View the transaction →](https://testnet.monadexplorer.com/tx/0xdb6f1f19d37f37428996492332f92eab12aec7982ac9abf8ba4bdaf1d799443f)

## The verify page

`web/` is a single static page — no build step, no framework, no backend. It reads the anchored batch
straight from the contract, hashes a decision record in your browser, and calls `verifyDecision` on
Monad. Six real decisions from the anchored run ship with it, each with its inclusion proof, so the
first click verifies something real.

The button next to it flips the verdict on the record. The hash changes, the chain rejects it, and
the page says why. That is the whole argument in one interaction.

```sh
npm run build && node scripts/export-samples.mjs <run-dump.json> web/samples.json
npx http-server web        # or any static server; it must be served over HTTP, not file://
```

## Design

Leaves are **double-hashed** — `keccak256(keccak256(decisionHash))` — so no internal node of the tree
can be passed off as a decision. Sibling pairs are **sorted** before hashing, so a proof carries no
direction bits. An unpaired node at any level is promoted unchanged rather than hashed with itself,
which would otherwise let it masquerade as its own parent.

The layout is deliberately OpenZeppelin `MerkleProof`-compatible, so on-chain verification is an
audited construction rather than something hand-rolled here.

Re-anchoring an existing root is rejected, so the first anchor time is the one that stands; otherwise
a later write could quietly move a batch's timestamp forward.

**The encodings are asserted byte-identical between TypeScript and Solidity** (`merkle.test.ts`). If
those ever drifted, valid proofs would be rejected on chain while passing locally — the worst failure
available in a system like this — so it is a test, not a comment.

## Layout

| Path | What |
|---|---|
| `src/merkle.ts` | Tree construction, proof generation, verification |
| `src/registry.ts` | `MonadAnchorer` (writes) and `MonadVerifier` (reads, no wallet needed) |
| `contracts/DecisionRegistry.sol` | Anchors roots; verifies inclusion on chain |
| `scripts/anchor-run.mjs` | Anchors a run and proves one of its decisions, end to end |

## Use

```sh
npm install
npm test          # 22 tests
npm run compile   # rebuilds src/artifacts from the contract
```

The compiled ABI and bytecode are committed, so consuming this package needs no Solidity toolchain —
only changing the contract does.

```ts
import { buildMerkleTree, proofFor, verifyProof } from "decision-passport";

const tree = buildMerkleTree(decisionHashes);   // one root for the whole run
const proof = proofFor(tree, 42);               // ~16 hashes
verifyProof(decisionHashes[42], proof, tree.root);
```

Deploying needs a funded key, read from a **file** rather than an argument or an inline env value, so
it cannot land in shell history or a process listing. It is never printed.

```sh
MONAD_DEPLOYER_KEY_FILE=./deployer.key npm run deploy   # MONAD_NETWORK=mainnet for chain 143
```

Chain definitions come from `viem/chains` (`monadTestnet` = 10143, `monad` = 143) rather than
hardcoded RPC URLs.

## Status

Merkle core, contract, anchorer and verifier: written, tested, deployed, and exercised against a real
run of 53,384 decisions. Next: ERC-8004 agent identity, x402-paid verification, and a public page
where anyone can paste a decision and check it against the chain.

## Licence

MIT
