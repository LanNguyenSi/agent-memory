import * as fs from "fs/promises";
import type { ScoredEntry } from "./scorer.js";

export interface WriteOptions {
  outputPath: string;
  dryRun: boolean;
  threshold: number;
  runDate: string;
}

export interface WriteResult {
  added: number;
  skipped: boolean;
  preview: string;
}

export async function writeDistilledEntries(
  entries: ScoredEntry[],
  options: WriteOptions
): Promise<WriteResult> {
  const { outputPath, dryRun, threshold, runDate } = options;

  const significant = entries
    .filter((e) => e.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (significant.length === 0) {
    return { added: 0, skipped: false, preview: "(no significant entries found)" };
  }

  const sectionHeader = `## Distilled: ${runDate}`;

  // Check if section already exists
  let existing = "";
  try {
    existing = await fs.readFile(outputPath, "utf-8");
  } catch {
    // File doesn't exist yet — will create
  }

  if (existing.includes(sectionHeader)) {
    return { added: 0, skipped: true, preview: `(section '${sectionHeader}' already exists)` };
  }

  // Build the new section
  const grouped = groupByType(significant);
  const lines: string[] = [`\n${sectionHeader}\n`];

  for (const [type, typeEntries] of Object.entries(grouped)) {
    if (typeEntries.length === 0) continue;
    lines.push(`\n### ${capitalize(type)}s\n`);
    for (const e of typeEntries) {
      lines.push(`- **[${e.date}]** ${e.text} *(score: ${e.score.toFixed(2)})*`);
    }
  }

  const section = lines.join("\n") + "\n";

  if (dryRun) {
    return { added: significant.length, skipped: false, preview: section };
  }

  await fs.appendFile(outputPath, section, "utf-8");
  return { added: significant.length, skipped: false, preview: section };
}

function groupByType(entries: ScoredEntry[]): Record<string, ScoredEntry[]> {
  const groups: Record<string, ScoredEntry[]> = {
    decision: [],
    lesson: [],
    insight: [],
    event: [],
  };
  for (const e of entries) {
    groups[e.type].push(e);
  }
  return groups;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
