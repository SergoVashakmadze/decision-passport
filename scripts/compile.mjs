#!/usr/bin/env node
/**
 * Compiles DecisionRegistry.sol into src/artifacts/DecisionRegistry.json (ABI + bytecode).
 *
 * The artifact is committed so that anchoring, verifying and the tests need no Solidity toolchain —
 * only deploying and changing the contract do. `npm run compile` then
 * `git diff` shows exactly what a contract change did to the deployed bytecode.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const solc = require("solc");

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const CONTRACT = "DecisionRegistry.sol";
const source = readFileSync(join(pkgRoot, "contracts", CONTRACT), "utf8");

const input = {
  language: "Solidity",
  sources: { [CONTRACT]: { content: source } },
  settings: {
    // Anchoring is the hot path and runs on every rebalance, so optimise for many calls.
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
const warnings = (output.errors ?? []).filter((e) => e.severity !== "error");
for (const w of warnings) console.warn(w.formattedMessage);
if (errors.length > 0) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}

const contract = output.contracts[CONTRACT].DecisionRegistry;
const artifact = {
  contractName: "DecisionRegistry",
  compiler: { version: solc.version(), optimizer: input.settings.optimizer, evmVersion: input.settings.evmVersion },
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
};

const outDir = join(pkgRoot, "src", "artifacts");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "DecisionRegistry.json"), `${JSON.stringify(artifact, null, 2)}\n`);

const sizeKb = (artifact.deployedBytecode.length / 2 - 1) / 1024;
console.log(`compiled with ${solc.version()}`);
console.log(`deployed size ${sizeKb.toFixed(2)} kB (EVM limit 24.00 kB)`);
console.log(`wrote src/artifacts/DecisionRegistry.json`);
