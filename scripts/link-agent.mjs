#!/usr/bin/env node
/**
 * Registers an ERC-8004 agent identity and points it at this decision registry.
 *
 *   node scripts/link-agent.mjs register <agent-card-url> [--link <chainId> <registryAddress>]
 *   node scripts/link-agent.mjs link <agentId> <chainId> <registryAddress>
 *
 * `register --link` does both halves in one transaction, using the ERC-8004 registration overload
 * that takes metadata entries. It is cheaper than registering and then linking (311k gas against
 * 356k), and it is atomic: there is no window in which the agent exists but names no registry.
 * `link` on its own is for an agent that already exists, or for repointing one.
 *
 * Both are writes to Monad **mainnet**, where the ERC-8004 registries live — they spend real MON,
 * and `register` mints an ERC-721 that cannot be unminted. Neither runs without `--confirm`; the
 * default is to print the transaction it would send and stop.
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
import { monad } from "viem/chains";
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
const args = argv.filter((a, i) => a !== "--confirm" && a !== "--link" && !(linkAt >= 0 && (i === linkAt + 1 || i === linkAt + 2)));
const [command] = args;

const usage = () => {
  console.error("usage: node scripts/link-agent.mjs register <agent-card-url> [--link <chainId> <registryAddress>] [--confirm]");
  console.error("       node scripts/link-agent.mjs link <agentId> <chainId> <registryAddress> [--confirm]");
  process.exit(1);
};

if (command !== "register" && command !== "link") usage();

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

const account = privateKeyToAccount(key);
const transport = http(process.env.MONAD_MAINNET_RPC_URL || undefined);
const publicClient = createPublicClient({ chain: monad, transport });
const walletClient = createWalletClient({ account, chain: monad, transport });
const identity = new AgentIdentity({ publicClient });

console.log(`network   ${monad.name} (chain id ${monad.id})`);
console.log(`registry  ${ERC8004_IDENTITY_REGISTRY}`);
console.log(`sender    ${account.address}`);
console.log(`balance   ${formatEther(await publicClient.getBalance({ address: account.address }))} MON`);

/** Describes the write, then sends it only once the caller has said so in the command line. */
async function send(label, request) {
  console.log(`\n${label}`);
  if (!confirmed) {
    console.log("Not sent. This is a mainnet write that spends real MON — re-run with --confirm.");
    process.exit(0);
  }
  const hash = await walletClient.writeContract({ ...request, account, chain: monad });
  console.log(`tx        ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error(`reverted in block ${receipt.blockNumber}`);
    process.exit(1);
  }
  console.log(`block     ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  console.log(`explorer  ${monad.blockExplorers?.default?.url}/tx/${hash}`);
  return receipt;
}

if (command === "register") {
  const [, agentURI] = args;
  if (!agentURI) usage();

  // Registering mints an ERC-721 that cannot be unminted, so a second identity for the same agent
  // is a mess that has to be lived with rather than undone. Say what exists before adding to it.
  const mine = await publicClient.readContract({
    address: ERC8004_IDENTITY_REGISTRY,
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
    const [chainIdArg, registryAddress] = linkOperands;
    if (!/^\d+$/.test(chainIdArg ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress ?? "")) usage();
    const ref = { chainId: Number(chainIdArg), address: registryAddress.toLowerCase() };

    receipt = await send(`register("${agentURI}", [${DECISION_REGISTRY_KEY}="${formatRegistryRef(ref)}"])`, {
      address: ERC8004_IDENTITY_REGISTRY,
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
      address: ERC8004_IDENTITY_REGISTRY,
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
} else {
  const [, agentIdArg, chainIdArg, registryAddress] = args;
  if (!/^\d+$/.test(agentIdArg ?? "") || !/^\d+$/.test(chainIdArg ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress ?? "")) usage();

  const agentId = BigInt(agentIdArg);
  const ref = { chainId: Number(chainIdArg), address: registryAddress.toLowerCase() };

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
    address: ERC8004_IDENTITY_REGISTRY,
    abi: ERC8004_IDENTITY_ABI,
    functionName: "setMetadata",
    args: [agentId, DECISION_REGISTRY_KEY, encodeRegistryRef(ref)],
  });
  console.log(`\nAgent #${agentId} now names ${formatRegistryRef(ref)} as its decision registry.`);
  console.log(`Check the binding with:  MONAD_REGISTRY_ADDRESS=${ref.address} node scripts/agent-passport.mjs ${agentId}`);
}
