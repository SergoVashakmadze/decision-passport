# Decision Passport — Handover

> Last updated 2026-09-21. Read `README.md` first — it is the argument; this file is the state.
> Project memory lives in `~/.claude/projects/-home-sergo-vashakmadze-Documents-d-drive-New-Projects-decision-passport/memory/`
> (`MEMORY.md` is the index). Every fact below was read off the chain on 2026-09-21, not remembered.

## ▶▶ START HERE (2026-09-21) — the passport is bound end to end on Monad testnet

A decision proves out to an agent, on one chain, with no server and no wallet:

```
decision → batch      inclusion proof against the anchored root
batch    → anchorer   DecisionRegistry records who anchored it
anchorer → agent      AgentIdentityRegistry says the agent authorises that key
agent    → registry   the agent's own record names this decision registry
```

**Live on Monad Testnet (chain 10143).**

| What | Where | Notes |
|---|---|---|
| `DecisionRegistry` | [`0x9444ad8e…dd7121`](https://testnet.monadexplorer.com/address/0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121) | Deployed 2026-09-17. Committed artifact byte-matches the deployed code |
| `AgentIdentityRegistry` | [`0x6ce06a82…38c6bf`](https://testnet.monadexplorer.com/address/0x6ce06a82cdf76367a3a112893c724fe5a738c6bf) | **This is the live one.** ERC-8004 conformant, not canonical |
| Anchored batch | root `0x9b361f46…3e6e911` | 53,384 decisions, one transaction, anchored 2026-09-17 |
| Agent | `#2`, owner `0x9d76055e…EfD10E` | Card inlined on chain as a `data:` URI |
| Agent card | https://dipbuyer.ai/.well-known/agent-card.json | A2A 0.3.0 path; byte-equivalent to the on-chain copy |
| Verify page | `web/` — static, no build | Reads both registries live; shows `bound: yes` |

**One address signs everything**, and it has to stay that way: `0x9d76055e4A327A1950d7c3d89587FCCF47EfD10E`
is the `DecisionRegistry` owner, the batch anchorer, and the owner of agent #2. The binding checks
`isAuthorizedOrOwner(anchoredBy, agentId)`, so registering an agent from any other key leaves that
half reading `no`. Key file: `~/.dipbuyer/monad-deployer.key` (outside the repo, mode 600). Pass it
as `MONAD_DEPLOYER_KEY_FILE=…`; every script reads the file itself, so the key is never typed.

**Balances (2026-09-21):** testnet **3.998 MON** (plenty), mainnet **0 MON**.

**Two superseded `AgentIdentityRegistry` deployments still have code on testnet** and are kept
deliberately — `0xc6436e8b…` (first, had the malleability bug) and `0xbd3de669…` (second, had the
zero-address bug). Nothing references them. They are listed here *only* so a future session that
finds three registries from the same key knows which one is live: it is `0x6ce06a82…`. Deliberately
not in the README.

## Tests

```sh
npm test                 # 43 unit tests (merkle, registry, identity, passport)
npm run compile          # rebuilds src/artifacts from contracts/
npx tsc --noEmit
```

There is **no local EVM**. The contracts are tested against a live deployment, the same choice
`merkle.test.ts` makes in asserting the TypeScript and Solidity encodings against each other:

```sh
MONAD_DEPLOYER_KEY_FILE=~/.dipbuyer/monad-deployer.key \
MONAD_IDENTITY_ADDRESS=0x6ce06a82cdf76367a3a112893c724fe5a738c6bf \
  node scripts/exercise-identity.mjs      # 27 checks, spends testnet MON
```

It registers agents and leaves them behind; that is expected. **Run it against any new deployment
before registering anything real against it.** Every check is a property the binding depends on.

## Read the whole passport

```sh
MONAD_REGISTRY_ADDRESS=0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121 \
MONAD_IDENTITY_ADDRESS=0x6ce06a82cdf76367a3a112893c724fe5a738c6bf \
  node scripts/agent-passport.mjs 2
```

Read-only, no key. Drop `MONAD_IDENTITY_ADDRESS` and it reads the **canonical** ERC-8004 registry on
Monad mainnet instead, where the binding correctly refuses — nothing of ours is registered there.

## The honest limitation, stated plainly

`AgentIdentityRegistry` is **conformant, not canonical**. Anyone can deploy one, so an identity in it
is worth exactly what the deployment is trusted for. It exists because the canonical ERC-8004
registries are Monad **mainnet**-only (Identity `0x8004A169…`, Reputation `0x8004BAa1…`; verified as
having no code at those addresses on testnet), which would otherwise split the passport across two
chains and reduce the binding to "one key controls both records".

The README says this. Do not quietly upgrade the claim.

## Next, in order

1. **Optional — canonical mainnet registration.** Needs MON at `0x9d76055e…` on chain 143
   (~0.032 MON; 0.05 comfortable). Blocked only on funding: the minimum MON purchase found was £4,
   and MetaMask's Swap is same-chain so it cannot do ETH→MON (that is a bridge, via `app.monad.xyz`).
   Owner's call — it buys an unimpeachable claim and costs the single-chain property. Flow:
   `link-agent.mjs register @web/agent-card.json --link 10143 <decisionRegistry>` (no
   `MONAD_IDENTITY_ADDRESS`/`MONAD_NETWORK` → canonical mainnet), then `set-card <agentId>`, then
   the passport check. Dry run first — everything is `--confirm`-gated.
   If done, the published card should list **both** registrations; `registrations` is an array for
   exactly that. Do not let the second overwrite the first.
2. **x402-paid verification.**
3. **ERC-8004 Reputation registry** (`0x8004BAa1…`, mainnet only).

## Rules that bind this repo

- **The registering key must be the anchoring key.** See above. This is the single easiest way to
  break the binding while everything else looks right.
- **`*.key` is gitignored.** The README tells you to create `./agent.key`; nothing has ever been
  committed, and it must stay that way.
- **Never write `agentWallet` as ordinary metadata.** It is reserved and settable only through
  `setAgentWallet`, which requires that wallet's own signature. Without that, anyone could name any
  address as their agent's and claim its anchored batches.
- **Acting as an agent is weaker than owning it.** A bound wallet may anchor; it may not repoint the
  registry, rebind the wallet, change the card, or transfer the identity.
- **`npm run compile` keeps an artifact when only solc's metadata hash moved.** That is deliberate:
  the committed `DecisionRegistry` artifact byte-matches the contract deployed at `0x9444ad8e…`, and
  a fresh metadata hash would break that match while changing nothing that runs.

## What the live suite caught that reading the code did not

Kept as a warning against trusting a Solidity review alone:

| Bug | What it would have done |
|---|---|
| Malleability constant 4 bytes short of `secp256k1n/2` | Rejected essentially every valid signature — no wallet could ever have been bound |
| `isAuthorizedOrOwner(address(0), …)` returned `true` | Authorised the zero address for **every** agent; an unanchored batch reads back `anchoredBy == 0x0` |
| `transferFrom` gated on agent authority | A hot anchoring key could have sold the identity |
| Card kept an earlier `agentId` | A mainnet registration would have minted one id while its card claimed another |

## Start-of-session checklist

1. `git -C . status -sb` — main should be level with `origin/main`.
2. `npm test` — 43 passing.
3. Run the passport command above — expect `bound: yes` and both inclusion checks `yes`.
4. If any of that disagrees with this file, **the chain and the code win, and this file gets fixed
   in the same change.**
