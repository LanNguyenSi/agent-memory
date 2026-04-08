import * as fs from "fs/promises";
import * as path from "path";
import type { MemoryFile, ScanOptions, ScanResult } from "./types";

const DEFAULT_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/; // YYYY-MM-DD.md

export async function scanMemoryFiles(
  options: ScanOptions,
): Promise<ScanResult> {
  const {
    directory,
    pattern = DEFAULT_PATTERN,
    daysBack = 7,
    recursive = false,
  } = options;

  const files: MemoryFile[] = [];
  const errors: string[] = [];
  let totalScanned = 0;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory() && recursive) {
        // Recursively scan subdirectories
        const subResult = await scanMemoryFiles({
          ...options,
          directory: fullPath,
        });
        files.push(...subResult.files);
        totalScanned += subResult.totalScanned;
        errors.push(...subResult.errors);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.match(pattern)) continue;

      totalScanned++;

      try {
        // Extract date from filename (YYYY-MM-DD.md)
        const dateMatch = entry.name.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!dateMatch) {
          errors.push(`Could not extract date from: ${entry.name}`);
          continue;
        }

        const fileDate = new Date(
          parseInt(dateMatch[1]),
          parseInt(dateMatch[2]) - 1,
          parseInt(dateMatch[3]),
        );

        // Skip files older than cutoff
        if (fileDate < cutoffDate) continue;

        const content = await fs.readFile(fullPath, "utf-8");
        const stat = await fs.stat(fullPath);

        files.push({
          path: fullPath,
          filename: entry.name,
          date: fileDate,
          content,
          size: stat.size,
        });
      } catch (err: any) {
        errors.push(`Error reading ${entry.name}: ${err.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`Error scanning directory ${directory}: ${err.message}`);
  }

  return {
    files: files.sort((a, b) => b.date.getTime() - a.date.getTime()),
    totalScanned,
    totalMatched: files.length,
    errors,
  };
}
