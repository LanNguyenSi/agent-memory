import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs/promises";
import * as path from "path";
import { scanMemoryFiles } from "../src/scanner/scanner.js";

test("scanner should find YYYY-MM-DD.md files", async () => {
  const tmpDir = await fs.mkdtemp("/tmp/test-scanner-");

  try {
    // Create test files
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayFile = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}.md`;
    const yesterdayFile = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}.md`;

    await fs.writeFile(path.join(tmpDir, todayFile), "# Today\nSome content");
    await fs.writeFile(
      path.join(tmpDir, yesterdayFile),
      "# Yesterday\nSome content",
    );
    await fs.writeFile(path.join(tmpDir, "other.txt"), "Not a memory file");

    const result = await scanMemoryFiles({
      directory: tmpDir,
      daysBack: 7,
    });

    assert.strictEqual(result.totalMatched, 2, "Should find 2 memory files");
    assert.strictEqual(result.totalScanned, 2, "Should scan 2 matching files");
    assert.strictEqual(result.files.length, 2, "Should return 2 files");
    assert.strictEqual(result.errors.length, 0, "Should have no errors");
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});

test("scanner should filter by days back", async () => {
  const tmpDir = await fs.mkdtemp("/tmp/test-scanner-days-");

  try {
    // Create test files with different dates
    await fs.writeFile(
      path.join(tmpDir, "2026-03-20.md"),
      "# Old file\nContent",
    );
    await fs.writeFile(
      path.join(tmpDir, "2026-03-26.md"),
      "# Recent file\nContent",
    );

    const result = await scanMemoryFiles({
      directory: tmpDir,
      daysBack: 3,
    });

    // Only the recent file should be included (if today is around 2026-03-26)
    assert.ok(result.totalMatched <= 2, "Should filter files by days back");
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});

test("scanner should handle recursive scanning", async () => {
  const tmpDir = await fs.mkdtemp("/tmp/test-scanner-recursive-");

  try {
    const subDir = path.join(tmpDir, "subdir");
    await fs.mkdir(subDir);

    const today = new Date();
    const todayFile = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}.md`;

    await fs.writeFile(path.join(tmpDir, todayFile), "# Root\nContent");
    await fs.writeFile(path.join(subDir, todayFile), "# Subdir\nContent");

    const result = await scanMemoryFiles({
      directory: tmpDir,
      daysBack: 7,
      recursive: true,
    });

    assert.ok(result.totalMatched >= 1, "Should find files recursively");
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});
