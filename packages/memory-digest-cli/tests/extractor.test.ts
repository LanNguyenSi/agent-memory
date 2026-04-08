import { test } from "node:test";
import assert from "node:assert";
import { extractInsights } from "../src/extractor/extractor.js";
import type { MemoryFile } from "../src/scanner/types.js";

test("extractor should find high-importance markers", () => {
  const files: MemoryFile[] = [
    {
      path: "/test/2026-03-26.md",
      filename: "2026-03-26.md",
      date: new Date("2026-03-26"),
      content: `# Daily Log
✅ COMPLETE: Finished the major project
🎉 SUCCESS: Deployment went perfectly
Just a normal line with no markers
⚠️ Warning about something minor`,
      size: 150,
    },
  ];

  const result = extractInsights(files);

  assert.ok(result.totalExtracted > 0, "Should extract insights");

  // Check that high-importance items are scored higher
  const highImportance = result.insights.filter((i) => i.importance > 0.7);
  assert.ok(highImportance.length > 0, "Should find high-importance insights");

  // Verify that items with success markers are detected
  const successInsights = result.insights.filter((i) =>
    i.text.includes("SUCCESS"),
  );
  assert.ok(successInsights.length > 0, "Should detect success markers");
});

test("extractor should determine insight types", () => {
  const files: MemoryFile[] = [
    {
      path: "/test/2026-03-26.md",
      filename: "2026-03-26.md",
      date: new Date("2026-03-26"),
      content: `# Daily Log
✅ Completed the implementation successfully
We decided to use TypeScript for the project
I learned that testing is important
TODO: Write more tests tomorrow`,
      size: 150,
    },
  ];

  const result = extractInsights(files);

  const types = new Set(result.insights.map((i) => i.type));

  // Should identify different types of insights
  assert.ok(types.size > 1, "Should identify multiple insight types");
});

test("extractor should filter low-importance content", () => {
  const files: MemoryFile[] = [
    {
      path: "/test/2026-03-26.md",
      filename: "2026-03-26.md",
      date: new Date("2026-03-26"),
      content: `# Daily Log
Short.
x
Just a normal sentence without any markers at all really just plain text.`,
      size: 100,
    },
  ];

  const result = extractInsights(files);

  // Should filter out very short lines and low-importance content
  const veryShort = result.insights.filter((i) => i.text.length < 10);
  assert.strictEqual(veryShort.length, 0, "Should filter very short lines");
});
