#!/usr/bin/env node
/**
 * Prints the passport for one decision: the decision, the batch it belongs to, and the ERC-8004
 * agent that made it.
 *
 *   MONAD_REGISTRY_ADDRESS=0x… node scripts/agent-passport.mjs <agentId> [samples.json]
 *
 * Read-only, and it reads two chains: the decision registry wherever it is deployed (testnet by
 * default), and the ERC-8004 identity registry on Monad mainnet, which is the only chain it exists
 * on. No wallet, no key — this is the check a sceptic runs, so it asks nothing of the operator.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { AgentIdentity, ERC8004_IDENTITY_REGISTRY, formatRegistryRef } from "../dist/identity.js";
import { decisionPassport } from "../dist/passport.js";
import { MonadVerifier } from "../dist/registry.js";

const [agentIdArg, samplesPath = "web/samples.json"] = process.argv.slice(2);
if (!agentIdArg || !/^\d+$/.test(agentIdArg)) {
  console.error("usage: MONAD_REGISTRY_ADDRESS=0x… node scripts/agent-passport.mjs <agentId> [samples.json]");
  process.exit(1);
}

const registryAddress = process.env.MONAD_REGISTRY_ADDRESS;
if (!registryAddress) {
  console.error("MONAD_REGISTRY_ADDRESS is not set");
  process.exit(1);
}

const decisionChain = process.env.MONAD_NETWORK === "mainnet" ? monad : monadTestnet;
const agentId = BigInt(agentIdArg);
const { root, samples } = JSON.parse(readFileSync(samplesPath, "utf8"));
const sample = samples?.[0];

const decisionClient = createPublicClient({ chain: decisionChain, transport: http(process.env.MONAD_RPC_URL || undefined) });
// The identity registry is mainnet-only, so it gets its own client even when the batch is on
// testnet. Pointing one client at both chains is exactly the mistake this separation prevents.
const identityClient = createPublicClient({ chain: monad, transport: http(process.env.MONAD_MAINNET_RPC_URL || undefined) });

const registry = { chainId: decisionChain.id, address: registryAddress.toLowerCase() };

const passport = await decisionPassport({
  verifier: new MonadVerifier({ publicClient: decisionClient, address: registryAddress }),
  identity: new AgentIdentity({ publicClient: identityClient }),
  registry,
  root,
  agentId,
  decisionHash: sample?.decisionHash,
  proof: sample?.proof,
});

const tick = (ok) => (ok ? "yes" : "no");

console.log(`batch    ${root}`);
if (!passport.batch) {
  console.log(`         not anchored on ${decisionChain.name}`);
} else {
  console.log(`         ${passport.batch.decisionCount.toLocaleString()} decisions, anchored ${passport.batch.anchoredAt.toISOString()}`);
  console.log(`         config ${passport.batch.configHash}`);
  console.log(`         by     ${passport.batch.anchoredBy}`);
}

console.log(`\nagent    #${agentId} in ${ERC8004_IDENTITY_REGISTRY} on ${monad.name}`);
if (!passport.agent) {
  console.log(`         not registered`);
} else {
  console.log(`         owner  ${passport.agent.owner}`);
  console.log(`         card   ${passport.agent.agentURI || "(none)"}`);
}

const { binding } = passport;
console.log(`\nbinding`);
console.log(`  agent names this registry   ${tick(binding.registryDeclared)}${
  binding.declaredRegistry && !binding.registryDeclared ? `  (it names ${formatRegistryRef(binding.declaredRegistry)})` : ""
}${binding.declaredRegistry === null ? `  (it names none; expected ${formatRegistryRef(registry)})` : ""}`);
console.log(`  agent authorises anchorer   ${tick(binding.anchorerAuthorized)}`);
console.log(`  bound                       ${tick(binding.bound)}`);

if (passport.decision) {
  console.log(`\ndecision ${sample.label} (${sample.verdict})`);
  console.log(`  ${passport.decision.decisionHash}`);
  console.log(`  proof is ${sample.proof.length} hashes for a batch of ${(passport.batch?.decisionCount ?? 0).toLocaleString()}`);
  console.log(`  in the batch, locally   ${tick(passport.decision.includedLocally)}`);
  console.log(`  in the batch, on chain  ${tick(passport.decision.includedOnChain)}`);
}

// A passport that only proves inclusion still leaves "whose decision was it?" unanswered, which is
// the question ERC-8004 is here to close. Say which half is missing rather than printing one verdict.
if (!binding.bound) {
  console.log(
    `\nThis batch is anchored and its decisions are provable, but it is not bound to agent #${agentId}.` +
      (binding.registryDeclared ? "" : `\n  The agent has not declared this registry — run scripts/link-agent.mjs.`) +
      (binding.anchorerAuthorized ? "" : `\n  The anchoring key is not one agent #${agentId} authorises.`),
  );
}
