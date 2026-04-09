import { describe, it, expect } from "vitest";
import { extractEntries } from "../src/analyzer/extractor.js";
import { scoreEntries } from "../src/analyzer/scorer.js";

describe("extractor", () => {
  it("extracts decisions", () => {
    const content = "I decided to use TypeScript for this project going forward.";
    const entries = extractEntries(content, "2026-03-26");
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("decision");
  });

  it("extracts lessons", () => {
    const content = "Learned that Docker slim images need ca-certificates explicitly installed.";
    const entries = extractEntries(content, "2026-03-26");
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("lesson");
  });

  it("extracts events", () => {
    const content = "Completed the full project-forge deployment pipeline today.";
    const entries = extractEntries(content, "2026-03-26");
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("event");
  });

  it("skips headings and short lines", () => {
    const content = "# Heading\nShort\nThis is a normal line with enough content to process.";
    const entries = extractEntries(content, "2026-03-26");
    // Only lines with pattern matches should appear
    expect(entries.every((e) => e.text.length >= 20)).toBe(true);
  });

  it("extracts multiple entries from a real memory file", () => {
    const content = `
# 2026-03-26

Decided to use Groq llama-3.3-70b as primary AI provider, OpenAI as fallback.

Learned that Docker Build Cache can silently serve stale images even after git pull.

Fixed the scaffoldkit integration by correcting the CLI invocation path.

Completed ice-reflection-engine scaffold and planning in one session.
    `.trim();
    const entries = extractEntries(content, "2026-03-26");
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });
});

describe("scorer", () => {
  it("scores decisions higher than events", () => {
    const entries = [
      { text: "I decided to use this approach.", type: "decision" as const, date: "2026-03-26", lineIndex: 0 },
      { text: "Completed the deployment task.", type: "event" as const, date: "2026-03-26", lineIndex: 1 },
    ];
    const scored = scoreEntries(entries, ["2026-03-26"]);
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it("boosts entries with high-value keywords", () => {
    const base = { date: "2026-03-26", lineIndex: 0, type: "event" as const };
    const normal = { ...base, text: "Completed the deployment task." };
    const critical = { ...base, text: "Critical: completed the deployment task." };
    const scored = scoreEntries([normal, critical], ["2026-03-26"]);
    const normalScore = scored.find((e) => e.text === normal.text)!.score;
    const criticalScore = scored.find((e) => e.text === critical.text)!.score;
    expect(criticalScore).toBeGreaterThan(normalScore);
  });

  it("all scores are between 0 and 1", () => {
    const entries = [
      { text: "Critical important key major decision made always.", type: "decision" as const, date: "2026-03-26", lineIndex: 0 },
    ];
    const scored = scoreEntries(entries, ["2026-03-26"]);
    expect(scored[0].score).toBeLessThanOrEqual(1);
    expect(scored[0].score).toBeGreaterThan(0);
  });
});
