import { test } from "node:test";
import assert from "node:assert";
import {
  generateDigest,
  formatDigestMarkdown,
} from "../src/digest/generator.js";
import type { ExtractedInsight } from "../src/extractor/types.js";

test("digest should summarize insights correctly", () => {
  const insights: ExtractedInsight[] = [
    {
      type: "event",
      text: "✅ Completed major project",
      importance: 0.9,
      source: "2026-03-26.md",
      date: new Date("2026-03-26"),
    },
    {
      type: "decision",
      text: "Decided to use TypeScript",
      importance: 0.7,
      source: "2026-03-25.md",
      date: new Date("2026-03-25"),
    },
    {
      type: "insight",
      text: "Learned about testing patterns",
      importance: 0.6,
      source: "2026-03-24.md",
      date: new Date("2026-03-24"),
    },
  ];

  const digest = generateDigest(insights, { maxInsights: 10 });

  assert.strictEqual(
    digest.summary.totalInsights,
    3,
    "Should count all insights",
  );
  assert.strictEqual(digest.summary.byType.event, 1, "Should count events");
  assert.strictEqual(
    digest.summary.byType.decision,
    1,
    "Should count decisions",
  );
  assert.ok(
    digest.summary.averageImportance > 0,
    "Should calculate average importance",
  );
});

test("digest should respect max insights limit", () => {
  const insights: ExtractedInsight[] = Array.from({ length: 100 }, (_, i) => ({
    type: "event" as const,
    text: `Event ${i}`,
    importance: 0.5,
    source: "2026-03-26.md",
    date: new Date("2026-03-26"),
  }));

  const digest = generateDigest(insights, { maxInsights: 10 });

  assert.strictEqual(
    digest.insights.length,
    10,
    "Should limit to max insights",
  );
});

test("markdown formatter should create valid output", () => {
  const insights: ExtractedInsight[] = [
    {
      type: "event",
      text: "✅ Test event",
      importance: 0.8,
      source: "2026-03-26.md",
      date: new Date("2026-03-26"),
    },
  ];

  const digest = generateDigest(insights);
  const markdown = formatDigestMarkdown(digest);

  assert.ok(markdown.includes("# Memory Digest"), "Should include title");
  assert.ok(markdown.includes("## Summary"), "Should include summary");
  assert.ok(markdown.includes("## Insights"), "Should include insights");
  assert.ok(markdown.includes("2026-03-26"), "Should include date");
  assert.ok(markdown.includes("Test event"), "Should include event text");
});
