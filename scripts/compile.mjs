#!/usr/bin/env node
/**
 * Compiles every contract in contracts/ into src/artifacts/<Name>.json (ABI + bytecode).
 *
 * The artifacts are committed so that anchoring, verifying and the tests need no Solidity toolchain —
 * only deploying and changing a contract do. `npm run compile` then
 * `git diff` shows exactly what a contract change did to the deployed bytecode.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const solc = require("solc");

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const contractsDir = join(pkgRoot, "contracts");
const files = readdirSync(contractsDir).filter((f) => f.endsWith(".sol")).sort();
if (files.length === 0) {
  console.error("no .sol files in contracts/");
  process.exit(1);
}

/**
 * One solc run per contract, rather than one run over all of them.
 *
 * solc appends a metadata hash to the bytecode, and that metadata lists the compilation unit's
 * sources — so compiling two contracts together changes both their bytecode, even though neither
 * contract changed and the executable code is identical. That silently breaks the byte-for-byte
 * match between a committed artifact and the contract already deployed on chain, which is the one
 * property these artifacts exist to provide.
 */
const settingsFor = (file) => ({
  language: "Solidity",
  sources: { [file]: { content: readFileSync(join(contractsDir, file), "utf8") } },
  settings: {
    // Anchoring is the hot path and runs on every rebalance, so optimise for many calls.
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
});


/**
 * Strips the CBOR metadata solc appends to bytecode: the final two bytes give its length.
 *
 * That trailing blob is a hash of the compilation metadata, not executable code, and it moves for
 * reasons that have nothing to do with the contract — which matters here because the committed
 * DecisionRegistry artifact byte-matches the contract deployed at 0x9444…, and rewriting it with a
 * fresh metadata hash would break that match while changing nothing that runs.
 */
function executableCode(bytecode) {
  const bytes = Buffer.from(bytecode.slice(2), "hex");
  if (bytes.length < 2) return bytecode;
  const cborLength = bytes.readUInt16BE(bytes.length - 2);
  if (cborLength + 2 > bytes.length) return bytecode;
  return `0x${bytes.subarray(0, bytes.length - cborLength - 2).toString("hex")}`;
}

const outDir = join(pkgRoot, "src", "artifacts");
mkdirSync(outDir, { recursive: true });
console.log(`compiled with ${solc.version()}`);

for (const file of files) {
  const input = settingsFor(file);
  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  const warnings = (output.errors ?? []).filter((e) => e.severity !== "error");
  for (const w of warnings) console.warn(w.formattedMessage);
  if (errors.length > 0) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }

  for (const [contractName, contract] of Object.entries(output.contracts[file] ?? {})) {
    const artifact = {
      contractName,
      compiler: { version: solc.version(), optimizer: input.settings.optimizer, evmVersion: input.settings.evmVersion },
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    };
    const artifactPath = join(outDir, `${contractName}.json`);
    let note = "";
    if (existsSync(artifactPath)) {
      const committed = JSON.parse(readFileSync(artifactPath, "utf8"));
      const sameCode = executableCode(committed.deployedBytecode) === executableCode(artifact.deployedBytecode);
      if (sameCode && committed.deployedBytecode !== artifact.deployedBytecode) {
        // Nothing that runs has changed, so keep the artifact that matches the chain and leave the
        // working tree clean. Otherwise `git diff` after every compile shows a diff, and the one
        // signal it exists to give — here is what your contract change did — is lost in the noise.
        artifact.bytecode = committed.bytecode;
        artifact.deployedBytecode = committed.deployedBytecode;
        note = "  (kept: only the metadata hash moved)";
      }
    }
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

    const sizeKb = (artifact.deployedBytecode.length / 2 - 1) / 1024;
    const over = sizeKb > 24 ? "  ** OVER THE EVM LIMIT **" : "";
    console.log(`  ${contractName.padEnd(22)} ${sizeKb.toFixed(2).padStart(6)} kB (limit 24.00)${over}${note}`);
  }
}
