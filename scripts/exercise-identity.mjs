#!/usr/bin/env node
/**
 * Exercises a deployed AgentIdentityRegistry against a live chain.
 *
 *   MONAD_DEPLOYER_KEY_FILE=./deployer.key MONAD_IDENTITY_ADDRESS=0x… \
 *     node scripts/exercise-identity.mjs
 *
 * This package has no local EVM — the contracts are exercised on testnet, the way merkle.test.ts
 * asserts the TypeScript and Solidity encodings against each other rather than trusting that they
 * agree. So these are the contract's tests, and they are the ones that matter: each checks a
 * property the binding depends on, and a registry that fails any of them cannot be trusted to say
 * whose decisions a batch holds.
 *
 * It spends testnet MON and leaves the agents it registers behind.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, stringToHex, hexToString, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { abi } = require("../src/artifacts/AgentIdentityRegistry.json");

const address = process.env.MONAD_IDENTITY_ADDRESS;
if (!address) {
  console.error("MONAD_IDENTITY_ADDRESS is not set");
  process.exit(1);
}
const keyFile = process.env.MONAD_DEPLOYER_KEY_FILE;
if (!keyFile) {
  console.error("MONAD_DEPLOYER_KEY_FILE is not set");
  process.exit(1);
}
const key = readFileSync(keyFile.startsWith("~/") ? keyFile.replace("~", homedir()) : keyFile, "utf8").trim();

const chain = process.env.MONAD_NETWORK === "mainnet" ? monad : monadTestnet;
const account = privateKeyToAccount(key);
const transport = http(process.env.MONAD_RPC_URL || undefined);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

let passed = 0;
let failed = 0;

const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

const read = (functionName, args) => publicClient.readContract({ address, abi, functionName, args });

async function write(functionName, args) {
  const hash = await walletClient.writeContract({ address, abi, functionName, args, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

/** Expects the call to revert; returns true when it does. A silent success here is a failed test. */
async function reverts(functionName, args, from = account.address) {
  try {
    await publicClient.call({ account: from, to: address, data: encodeFunctionData({ abi, functionName, args }) });
    return false;
  } catch {
    return true;
  }
}

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const agentIdFrom = (receipt) =>
  BigInt(receipt.logs.find((l) => l.topics[0] === TRANSFER && /^0x0{64}$/.test(l.topics[1] ?? "")).topics[3]);

console.log(`registry ${address} on ${chain.name}`);
console.log(`sender   ${account.address}\n`);

// ---- registration -------------------------------------------------------------------------
console.log("registration");
const uri = "https://example.test/agent-card.json";
const linkValue = stringToHex("eip155:10143:0x9444ad8eaa2b17fc725827ab4cc8a73725dd7121");
const receipt = await write("register", [uri, [{ metadataKey: "decisionRegistry", metadataValue: linkValue }]]);
const agentId = agentIdFrom(receipt);
console.log(`  registered agent #${agentId} in ${receipt.gasUsed} gas`);

check("owner is the registrant", (await read("ownerOf", [agentId])) === account.address);
check("agentURI round-trips", (await read("tokenURI", [agentId])) === uri);
check("metadata set at registration", hexToString(await read("getMetadata", [agentId, "decisionRegistry"])).startsWith("eip155:10143:"));
check("agentExists", (await read("agentExists", [agentId])) === true);
check("totalAgents counts it", (await read("totalAgents", [])) > 0n);
check("unregistered id has no owner", await reverts("ownerOf", [agentId + 999_999n]));

// ---- authorisation ------------------------------------------------------------------------
console.log("\nauthorisation");
const stranger = privateKeyToAccount(generatePrivateKey());
check("owner is authorised", (await read("isAuthorizedOrOwner", [account.address, agentId])) === true);
check("a stranger is not", (await read("isAuthorizedOrOwner", [stranger.address, agentId])) === false);
check("nobody is authorised for an agent that does not exist",
  (await read("isAuthorizedOrOwner", [account.address, agentId + 999_999n])) === false);
check("a stranger cannot set metadata",
  await reverts("setMetadata", [agentId, "decisionRegistry", stringToHex("eip155:1:0xdead")], stranger.address));
check("a stranger cannot change the agentURI",
  await reverts("setAgentURI", [agentId, "https://attacker.test/card.json"], stranger.address));

// ---- the reserved key ---------------------------------------------------------------------
console.log("\nthe reserved agentWallet key");
// Writing it as ordinary metadata would let anyone name any address as their agent's, and so claim
// that address's anchored batches. It is the single most load-bearing check in this contract.
check("agentWallet cannot be written as metadata",
  await reverts("setMetadata", [agentId, "agentWallet", stringToHex(stranger.address)]));

// ---- agent wallets need the wallet's own signature ------------------------------------------
console.log("\nagent wallets");
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const domain = { name: "AgentIdentity", version: "1", chainId: chain.id, verifyingContract: address };
const types = { AgentWallet: [{ name: "agentId", type: "uint256" }, { name: "wallet", type: "address" }, { name: "deadline", type: "uint256" }] };

check("binding a wallet fails without its signature",
  await reverts("setAgentWallet", [agentId, stranger.address, deadline, `0x${"11".repeat(65)}`]));

// A signature from the *owner* must not work either: the point is the wallet's own consent.
const ownerSig = await walletClient.signTypedData({ account, domain, types, primaryType: "AgentWallet", message: { agentId, wallet: stranger.address, deadline } });
check("the owner cannot sign on the wallet's behalf",
  await reverts("setAgentWallet", [agentId, stranger.address, deadline, ownerSig]));

const strangerWallet = createWalletClient({ account: stranger, chain, transport });
const goodSig = await strangerWallet.signTypedData({ account: stranger, domain, types, primaryType: "AgentWallet", message: { agentId, wallet: stranger.address, deadline } });
check("an expired signature is refused",
  await reverts("setAgentWallet", [agentId, stranger.address, 1n, goodSig]));

await write("setAgentWallet", [agentId, stranger.address, deadline, goodSig]);
check("a wallet that signed is bound", (await read("getAgentWallet", [agentId])) === stranger.address);
check("and is then authorised to act as the agent", (await read("isAuthorizedOrOwner", [stranger.address, agentId])) === true);

// Acting as the agent is deliberately weaker than controlling it. The wallet is a hot key that
// anchors a batch every rebalance; if it could also repoint the registry or sell the identity, the
// binding would be worth only as much as the hot key's hygiene.
check("but cannot repoint the decision registry",
  await reverts("setMetadata", [agentId, "decisionRegistry", stringToHex("eip155:1:0xdead")], stranger.address));
check("nor rebind the agent wallet",
  await reverts("unsetAgentWallet", [agentId], stranger.address));
check("nor change the agent card",
  await reverts("setAgentURI", [agentId, "https://attacker.test/card.json"], stranger.address));
check("nor transfer the identity away",
  await reverts("transferFrom", [account.address, stranger.address, agentId], stranger.address));

// ---- transfer clears the wallet -------------------------------------------------------------
console.log("\ntransfer");
const buyer = privateKeyToAccount(generatePrivateKey());
await write("transferFrom", [account.address, buyer.address, agentId]);
check("ownership moved", (await read("ownerOf", [agentId])) === buyer.address);
// The wallet authorised the seller's agent, not the buyer's.
check("the agent wallet was cleared", (await read("getAgentWallet", [agentId])) === "0x0000000000000000000000000000000000000000");
check("the old wallet is no longer authorised", (await read("isAuthorizedOrOwner", [stranger.address, agentId])) === false);
check("the seller is no longer authorised", (await read("isAuthorizedOrOwner", [account.address, agentId])) === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
