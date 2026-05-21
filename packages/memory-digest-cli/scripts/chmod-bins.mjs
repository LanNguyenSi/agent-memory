#!/usr/bin/env node
// Postbuild step: tsc emits .js without the execute bit, so the bin
// targets registered in package.json fail with "Permission denied"
// after every rebuild when the package is installed via `npm link`
// (npm only chmods bin targets on registry installs, not on local
// links). This script reads the bin map and restores 0o755 on each
// target so the published tarball and the linked dev install behave
// the same.

import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const bin = pkg.bin ?? {};
const targets = typeof bin === "string" ? [bin] : Object.values(bin);
if (targets.length === 0) {
  console.log("chmod-bins: no bin entries declared, nothing to do");
  process.exit(0);
}

let failed = 0;
for (const rel of targets) {
  const abs = resolve(__dirname, "..", rel);
  if (!existsSync(abs)) {
    console.error(`chmod-bins: missing build output ${rel} (expected at ${abs})`);
    failed++;
    continue;
  }
  chmodSync(abs, 0o755);
}

if (failed > 0) {
  console.error(
    `chmod-bins: ${failed} bin target(s) missing; did the build produce them?`,
  );
  process.exit(1);
}

console.log(`chmod-bins: set 0o755 on ${targets.length} bin target(s)`);
