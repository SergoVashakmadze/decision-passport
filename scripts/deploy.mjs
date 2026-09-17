#!/usr/bin/env node
/**
 * Deploys DecisionRegistry to Monad.
 *
 *   MONAD_DEPLOYER_KEY_FILE=./deployer.key node scripts/deploy.mjs
 *   MONAD_NETWORK=mainnet ...                       # default: testnet
 *
 * The key is read from a file, not an argument or an inline env value, so it never lands in shell
 * history or a process listing. It is never printed. Nothing else in this package needs a key —
 * verification is read-only and anchoring takes an account the caller already built.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const artifact = require("../src/artifacts/DecisionRegistry.json");

const network = process.env.MONAD_NETWORK === "mainnet" ? "mainnet" : "testnet";
const chain = network === "mainnet" ? monad : monadTestnet;

const keyFile = process.env.MONAD_DEPLOYER_KEY_FILE;
if (!keyFile) {
  console.error("MONAD_DEPLOYER_KEY_FILE is not set. Point it at a file containing the 0x-prefixed private key.");
  process.exit(1);
}

const resolved = keyFile.startsWith("~/") ? keyFile.replace("~", homedir()) : keyFile;
const key = readFileSync(resolved, "utf8").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error(`${keyFile} does not contain a 0x-prefixed 32-byte private key.`);
  process.exit(1);
}

const account = privateKeyToAccount(key);
const transport = http(process.env.MONAD_RPC_URL || undefined);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

console.log(`network   ${chain.name} (chain id ${chain.id})`);
console.log(`deployer  ${account.address}`);

const balance = await publicClient.getBalance({ address: account.address });
console.log(`balance   ${formatEther(balance)} MON`);
if (balance === 0n) {
  console.error(`\nDeployer has no MON. Fund ${account.address} from the faucet and run again.`);
  process.exit(1);
}

console.log("\ndeploying DecisionRegistry…");
const hash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  account,
  chain,
});
console.log(`tx        ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) {
  console.error(`deployment failed: status ${receipt.status}`);
  process.exit(1);
}

const explorer = chain.blockExplorers?.default?.url;
console.log(`\n✅ DecisionRegistry deployed`);
console.log(`address   ${receipt.contractAddress}`);
console.log(`block     ${receipt.blockNumber}`);
console.log(`gas used  ${receipt.gasUsed}`);
if (explorer) console.log(`explorer  ${explorer}/address/${receipt.contractAddress}`);
console.log(`\nSet MONAD_REGISTRY_ADDRESS=${receipt.contractAddress}`);
