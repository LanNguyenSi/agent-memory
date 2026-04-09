import { describe, it, expect } from "vitest";
import { extractEntries } from "../src/analyzer/extractor.js";
import { scoreEntries } from "../src/analyzer/scorer.js";
import { scanMemoryFiles } from "../src/analyzer/scanner.js";
import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";

describe("CLI integration (scanner + extractor + scorer)", () => {
  it("full pipeline on a temp directory produces scored entries", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ire-test-"));
    const content = `
# 2026-03-26

Decided to use TypeScript for this project going forward.
Learned that Docker slim images need ca-certificates explicitly installed.
Completed the full deployment pipeline today.
Critical milestone: first API test successful.
    `.trim();
    await fs.writeFile(path.join(tmpDir, "2026-03-26.md"), content, "utf-8");

    const files = await scanMemoryFiles(tmpDir);
    expect(files).toHaveLength(1);

    const entries = extractEntries(files[0].content, files[0].date);
    expect(entries.length).toBeGreaterThan(0);

    const scored = scoreEntries(entries, [files[0].date]);
    expect(scored.every((e) => e.score >= 0 && e.score <= 1)).toBe(true);

    await fs.rm(tmpDir, { recursive: true });
  });
});
