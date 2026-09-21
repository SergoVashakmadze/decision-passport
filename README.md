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

## Whose decisions were they?

The registry proves a set of decisions existed under a named config. It does not say whose they
were: all it records is the address that sent the anchoring transaction, and an address is not an
identity. [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) is where the identity lives — an
ERC-721 whose token id is the agent id, whose owner is the controlling key, and whose `agentURI` is
the agent card.

Binding the two takes **both directions**, because either alone is claimable by anyone:

| | |
|---|---|
| agent → registry | the agent's own identity record names this decision registry, in a `decisionRegistry` metadata entry only the agent can write |
| registry → agent | the batch was anchored by a key the agent authorises (`isAuthorizedOrOwner`) |

The first without the second lets any address anchor into a registry the agent named. The second
without the first lets an agent's key anchor anywhere and have it read back as the agent's. Both
together are the claim: *this agent says its decisions live here, and this batch was put here by the
agent's own key.*

The registry is named in [CAIP-10](https://chainagnostic.org/CAIPs/caip-10) form — `eip155:10143:0x9444…`
— because the two records are not on the same chain. The ERC-8004 registries are Monad **mainnet**
only (Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation
`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`; there is no code at either address on testnet), while
this registry is deployed on testnet. So the identity reads go through their own client, and the
binding is a statement about one key controlling both records — not something either chain attests
on its own. Saying that plainly is the point; a passport that quietly implied one chain had checked
the other would be the more impressive and less true thing to build.

`scripts/agent-passport.mjs` assembles the whole chain of custody read-only, no wallet and no key,
against both live chains:

```sh
MONAD_REGISTRY_ADDRESS=0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121 \
  node scripts/agent-passport.mjs 2
```

```
batch    0x9b361f4620dda3d51aa6c3806928e52a981970c0740594bde912d8e5f3e6e911
         53,384 decisions, anchored 2026-09-17T20:06:47.000Z
         by     0x9d76055e4A327A1950d7c3d89587FCCF47EfD10E

agent    #2 in 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 on Monad
         owner  0x8dF64bACf6b70F7787f8d14429b258B3fF958ec1

binding
  agent names this registry   no  (it names none)
  agent authorises anchorer   no
  bound                       no

decision QCOM · 2017-03-30 (buy)
  in the batch, locally   yes
  in the batch, on chain  yes
```

That is agent #2 — someone else's agent, picked off the live registry — and the binding correctly
refuses. The decision still proves out, because inclusion and identity are separate questions and a
failed identity binding does not un-anchor a batch. **No agent of ours is registered yet**: minting
one is a mainnet write that spends real MON, so `scripts/link-agent.mjs` prints the transaction and
stops unless passed `--confirm`.

```sh
MONAD_DEPLOYER_KEY_FILE=./agent.key node scripts/link-agent.mjs register https://dipbuyer.ai/agent-card.json
MONAD_DEPLOYER_KEY_FILE=./agent.key node scripts/link-agent.mjs link <agentId> 10143 0x9444… --confirm
```

It refuses before spending anything if the sending key is not one the agent authorises, rather than
letting the write revert on chain.

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
| `src/identity.ts` | ERC-8004 agent identity reads, and the registry declaration |
| `src/passport.ts` | Composes both chains into one passport: decision → batch → anchorer → agent |
| `contracts/DecisionRegistry.sol` | Anchors roots; verifies inclusion on chain |
| `scripts/anchor-run.mjs` | Anchors a run and proves one of its decisions, end to end |
| `scripts/agent-passport.mjs` | Reads the full chain of custody for one decision |
| `scripts/link-agent.mjs` | Registers an ERC-8004 identity and points it at this registry |

## Use

```sh
npm install
npm test          # 43 tests
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

Merkle core, contract, anchorer, verifier and the verify page: written, tested, deployed, and
exercised against a real run of 53,384 decisions on Monad testnet.

ERC-8004 agent identity: reader, both halves of the binding, the passport and both scripts are
written and tested, and run against the live mainnet registry — its interface was read off the
deployed bytecode rather than the specification, because the deployed revision is older than the
current reference implementation and three spec functions are simply not in it. What has *not*
happened is registering an agent of ours: that is a mainnet write spending real MON, so it is a
decision to take deliberately rather than something a build step does. Until it does, the verify
page covers decision → batch, and the identity half is the CLI.

Next: x402-paid verification, and the ERC-8004 Reputation registry.

## Attribution

Third-party work this builds on:

- **[viem](https://github.com/wevm/viem)** (MIT) — RPC client, keccak256 and ABI encoding.
- **[OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts)** (MIT) — no
  code is vendored, but the Merkle layout deliberately matches their `MerkleProof` conventions
  (double-hashed leaves, sorted sibling pairs) so proofs are interchangeable with that audited
  implementation.
- **[solc](https://github.com/ethereum/solidity)** (GPL-3.0) — used as a build tool to produce the
  committed artifact; it is not linked into or distributed with this code.
- **[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)** and its
  [reference implementation](https://github.com/ChaosChain/trustless-agents-erc-ri) (CC0-1.0) — no
  code is vendored. `ERC8004_IDENTITY_ABI` describes someone else's deployed contract: the function
  names come from the standard, and every one was checked against the selectors in the deployed
  implementation before being relied on.
- Chain parameters for Monad mainnet (143) and testnet (10143) come from viem's chain registry.

Everything else in this repository is original work written for Metropolis during the build window.

## Licence

MIT
