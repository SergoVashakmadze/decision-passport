#!/usr/bin/env node
/**
 * Registers an ERC-8004 agent identity and points it at this decision registry.
 *
 *   node scripts/link-agent.mjs register <agent-card-url|@card.json> [--link <chainId> <registryAddress>]
 *   node scripts/link-agent.mjs link <agentId> <chainId> <registryAddress>
 *   node scripts/link-agent.mjs set-card <agentId> <card.json>
 *
 * An `@card.json` argument inlines that file as a `data:` URI instead of pointing at a URL. An
 * agent card that 404s is worse than no card, and inlining it means the identity carries its own
 * card with nothing left to host. `set-card` rewrites it later — after registration, when the agent
 * id it should name finally exists.
 *
 * `register --link` does both halves in one transaction, using the ERC-8004 registration overload
 * that takes metadata entries. It is cheaper than registering and then linking (311k gas against
 * 356k), and it is atomic: there is no window in which the agent exists but names no registry.
 * `link` on its own is for an agent that already exists, or for repointing one.
 *
 * By default these are writes to Monad **mainnet**, where the canonical ERC-8004 registries live —
 * they spend real MON, and `register` mints an ERC-721 that cannot be unminted. Set
 * MONAD_IDENTITY_ADDRESS (with MONAD_NETWORK=testnet) to write to an AgentIdentityRegistry
 * deployed beside the batch instead. Nothing runs without `--confirm`; the default is to print the
 * transaction it would send and stop.
 *
 * The key is read from a file, like scripts/deploy.mjs, so it never lands in shell history or a
 * process listing, and it is never printed.
 *
 *   MONAD_DEPLOYER_KEY_FILE=./agent.key node scripts/link-agent.mjs link 7 10143 0x9444… --confirm
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import {
  AgentIdentity,
  DECISION_REGISTRY_KEY,
  ERC8004_IDENTITY_ABI,
  ERC8004_IDENTITY_REGISTRY,
  encodeRegistryRef,
  formatRegistryRef,
} from "../dist/identity.js";

const argv = process.argv.slice(2);
const confirmed = argv.includes("--confirm");
const linkAt = argv.indexOf("--link");
// `--link a b` consumes its two operands, so the positional arguments stay positional.
const linkOperands = linkAt >= 0 ? argv.slice(linkAt + 1, linkAt + 3) : [];

/**
 * Inlines an agent card as a `data:` URI, filling in the parts only the chain can supply.
 *
 * A card written before registration cannot name its own agent id, so `agentId` is patched in here
 * rather than left null in something that claims to describe the agent.
 */
function cardDataUri(file, { agentId = null, registry = null } = {}) {
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(card.registrations)) {
    card.registrations = card.registrations.map((r) => ({
      ...r,
      agentId: agentId === null ? r.agentId : Number(agentId),
      agentRegistry: `eip155:${chain.id}:${registryAddress.toLowerCase()}`,
    }));
  }
  if (registry) card.decisionRegistry = formatRegistryRef(registry);
  return `data:application/json,${encodeURIComponent(JSON.stringify(card))}`;
}

/** `@file` inlines a card; anything else is used as given. */
const resolveURI = (arg, opts) => (arg.startsWith("@") ? cardDataUri(arg.slice(1), opts) : arg);

const args = argv.filter((a, i) => a !== "--confirm" && a !== "--link" && !(linkAt >= 0 && (i === linkAt + 1 || i === linkAt + 2)));
const [command] = args;

const usage = () => {
  console.error("usage: node scripts/link-agent.mjs register <agent-card-url|@card.json> [--link <chainId> <registryAddress>] [--confirm]");
  console.error("       node scripts/link-agent.mjs link <agentId> <chainId> <registryAddress> [--confirm]");
  console.error("       node scripts/link-agent.mjs set-card <agentId> <card.json> [--confirm]");
  console.error("");
  console.error("  @card.json inlines that file as a data: URI instead of pointing at a URL.");
  console.error("  MONAD_IDENTITY_ADDRESS + MONAD_NETWORK=testnet target a self-deployed registry;");
  console.error("  the default is the canonical ERC-8004 registry on Monad mainnet.");
  process.exit(1);
};

if (command !== "register" && command !== "link" && command !== "set-card") usage();

const keyFile = process.env.MONAD_DEPLOYER_KEY_FILE;
if (!keyFile) {
  console.error("MONAD_DEPLOYER_KEY_FILE is not set. Point it at a file containing the 0x-prefixed private key.");
  process.exit(1);
}
const key = readFileSync(keyFile.startsWith("~/") ? keyFile.replace("~", homedir()) : keyFile, "utf8").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error(`${keyFile} does not contain a 0x-prefixed 32-byte private key.`);
  process.exit(1);
}

// The canonical registry is on mainnet; a self-deployed one is wherever it was deployed. The chain
// follows the registry, so a testnet address can never be written through a mainnet client.
const registryAddress = process.env.MONAD_IDENTITY_ADDRESS ?? ERC8004_IDENTITY_REGISTRY;
const chain = process.env.MONAD_NETWORK === "testnet" ? monadTestnet : monad;
const account = privateKeyToAccount(key);
const transport = http(
  (chain.id === monad.id ? process.env.MONAD_MAINNET_RPC_URL : process.env.MONAD_RPC_URL) || undefined,
);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const identity = new AgentIdentity({ publicClient, address: registryAddress });

console.log(`network   ${chain.name} (chain id ${chain.id})`);
console.log(`registry  ${registryAddress}${registryAddress === ERC8004_IDENTITY_REGISTRY ? "  (canonical ERC-8004)" : ""}`);
console.log(`sender    ${account.address}`);
console.log(`balance   ${formatEther(await publicClient.getBalance({ address: account.address }))} MON`);

/** Describes the write, then sends it only once the caller has said so in the command line. */
async function send(label, request) {
  console.log(`\n${label}`);
  if (!confirmed) {
    console.log(`Not sent. This is a ${chain.name} write${chain.id === monad.id ? " that spends real MON" : ""} — re-run with --confirm.`);
    process.exit(0);
  }
  const hash = await walletClient.writeContract({ ...request, account, chain });
  console.log(`tx        ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error(`reverted in block ${receipt.blockNumber}`);
    process.exit(1);
  }
  console.log(`block     ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  console.log(`explorer  ${chain.blockExplorers?.default?.url}/tx/${hash}`);
  return receipt;
}

if (command === "register") {
  const [, agentURIArg] = args;
  if (!agentURIArg) usage();
  const linkRef = linkAt >= 0 && linkOperands.length === 2 && /^\d+$/.test(linkOperands[0])
    ? { chainId: Number(linkOperands[0]), address: String(linkOperands[1]).toLowerCase() }
    : null;
  const agentURI = resolveURI(agentURIArg, { registry: linkRef });

  // Registering mints an ERC-721 that cannot be unminted, so a second identity for the same agent
  // is a mess that has to be lived with rather than undone. Say what exists before adding to it.
  const mine = await publicClient.readContract({
    address: registryAddress,
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [account.address],
  });
  if (mine > 0n) {
    console.log(`\n${account.address} already owns ${mine} agent identit${mine === 1n ? "y" : "ies"} here.`);
    console.log("Registering again mints another one, which cannot be unminted. Use `link` instead if you meant the existing agent.");
    if (!confirmed) process.exit(1);
  }

  let receipt;
  if (linkAt >= 0) {
    // Named for what it is: the *decision* registry the agent will point at. Calling it
    // registryAddress shadowed the identity registry this script writes to, and sent the
    // registration to the wrong contract.
    const [chainIdArg, decisionRegistryAddress] = linkOperands;
    if (!/^\d+$/.test(chainIdArg ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(decisionRegistryAddress ?? "")) usage();
    const ref = { chainId: Number(chainIdArg), address: decisionRegistryAddress.toLowerCase() };

    receipt = await send(`register("${agentURI}", [${DECISION_REGISTRY_KEY}="${formatRegistryRef(ref)}"])`, {
      address: registryAddress,
      abi: [{
        type: "function", name: "register", stateMutability: "nonpayable",
        inputs: [
          { name: "agentURI", type: "string" },
          { name: "metadata", type: "tuple[]", components: [{ name: "key", type: "string" }, { name: "value", type: "bytes" }] },
        ],
        outputs: [{ type: "uint256" }],
      }],
      functionName: "register",
      args: [agentURI, [{ key: DECISION_REGISTRY_KEY, value: encodeRegistryRef(ref) }]],
    });
  } else {
    receipt = await send(`register("${agentURI}")`, {
      address: registryAddress,
      abi: [{ type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ type: "uint256" }] }],
      functionName: "register",
      args: [agentURI],
    });
  }

  // The agent id is assigned by the contract, so it is read back from the mint rather than guessed:
  // the ERC-721 Transfer whose sender is the zero address, whose third topic is the token id.
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const mint = receipt.logs.find((l) => l.topics[0] === TRANSFER && /^0x0{64}$/.test(l.topics[1] ?? ""));
  const agentId = mint ? BigInt(mint.topics[3]) : null;

  if (agentId === null) {
    console.log("\nRegistered, but no mint log was found in the receipt — check the explorer for the agent id.");
  } else {
    console.log(`\nAgent id  ${agentId}`);
    if (linkAt >= 0) {
      console.log(`\nRegistered and linked in one transaction. Check the binding with:`);
      console.log(`  MONAD_REGISTRY_ADDRESS=${linkOperands[1].toLowerCase()} node scripts/agent-passport.mjs ${agentId}`);
      console.log(`\nThen set "agentId": ${agentId} in web/samples.json to turn on the verify page's identity panel.`);
    } else {
      console.log(`\nNow point it at the decision registry:`);
      console.log(`  node scripts/link-agent.mjs link ${agentId} 10143 $MONAD_REGISTRY_ADDRESS --confirm`);
    }
  }
} else if (command === "set-card") {
  const [, agentIdArg, cardFile] = args;
  if (!/^\d+$/.test(agentIdArg ?? "") || !cardFile) usage();
  const agentId = BigInt(agentIdArg);

  const agent = await identity.agent(agentId);
  if (!agent) {
    console.error(`\nAgent #${agentId} is not registered.`);
    process.exit(1);
  }
  if (!(await identity.isAuthorized(agentId, account.address))) {
    console.error(`\n${account.address} is not authorised to act for agent #${agentId}; this write would revert.`);
    process.exit(1);
  }
  const declared = await identity.declaredRegistry(agentId);
  const uri = cardDataUri(cardFile, { agentId, registry: declared });

  await send(`setAgentURI(${agentId}, <${uri.length} byte data: URI from ${cardFile}>)`, {
    address: registryAddress,
    abi: [{ type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "string" }], outputs: [] }],
    functionName: "setAgentURI",
    args: [agentId, uri],
  });
  console.log(`\nAgent #${agentId} now carries its own card, naming itself and its decision registry.`);
} else {
  const [, agentIdArg, chainIdArg, decisionRegistryAddress] = args;
  if (!/^\d+$/.test(agentIdArg ?? "") || !/^\d+$/.test(chainIdArg ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(decisionRegistryAddress ?? "")) usage();

  const agentId = BigInt(agentIdArg);
  const ref = { chainId: Number(chainIdArg), address: decisionRegistryAddress.toLowerCase() };

  // Only a key the agent authorises can write its metadata, so a sender that is not authorised
  // would revert on chain. Failing here costs nothing and says why.
  const agent = await identity.agent(agentId);
  if (!agent) {
    console.error(`\nAgent #${agentId} is not registered.`);
    process.exit(1);
  }
  console.log(`agent     #${agentId}, owner ${agent.owner}`);
  if (!(await identity.isAuthorized(agentId, account.address))) {
    console.error(`\n${account.address} is not authorised to act for agent #${agentId}; this write would revert.`);
    process.exit(1);
  }

  const existing = await identity.declaredRegistry(agentId);
  if (existing && formatRegistryRef(existing) === formatRegistryRef(ref)) {
    console.log(`\nAlready declared: ${formatRegistryRef(ref)}. Nothing to do.`);
    process.exit(0);
  }
  if (existing) console.log(`declared  ${formatRegistryRef(existing)} (will be replaced)`);

  await send(`setMetadata(${agentId}, "${DECISION_REGISTRY_KEY}", "${formatRegistryRef(ref)}")`, {
    address: registryAddress,
    abi: ERC8004_IDENTITY_ABI,
    functionName: "setMetadata",
    args: [agentId, DECISION_REGISTRY_KEY, encodeRegistryRef(ref)],
  });
  console.log(`\nAgent #${agentId} now names ${formatRegistryRef(ref)} as its decision registry.`);
  console.log(`Check the binding with:  MONAD_REGISTRY_ADDRESS=${ref.address} node scripts/agent-passport.mjs ${agentId}`);
}
