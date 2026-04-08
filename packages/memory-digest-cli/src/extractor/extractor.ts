import type { MemoryFile } from "../scanner/types";
import type { ExtractedInsight, ExtractionResult } from "./types";

// Keywords that indicate important events, decisions, or insights
const IMPORTANCE_MARKERS = {
  high: ["✅", "🎉", "🚀", "COMPLETE", "SUCCESS", "BREAKTHROUGH", "CRITICAL"],
  medium: ["✓", "🔥", "IMPORTANT", "NOTE", "DECISION", "TODO"],
  low: ["⚠️", "💭", "idea", "consider"],
};

const TYPE_MARKERS = {
  event: [
    "happened",
    "completed",
    "finished",
    "deployed",
    "launched",
    "✅",
    "🎉",
  ],
  decision: ["decided", "chose", "will", "going to", "DECISION"],
  insight: ["learned", "realized", "discovered", "found", "💡", "insight"],
  action: ["TODO", "need to", "must", "should", "[ ]"],
};

export function extractInsights(files: MemoryFile[]): ExtractionResult {
  const insights: ExtractedInsight[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 10) continue;

      // Skip headers and markdown syntax
      if (trimmed.startsWith("#") || trimmed.startsWith("---")) continue;

      // Calculate importance score
      const importance = calculateImportance(trimmed);
      if (importance < 0.3) continue; // Filter out low-importance lines

      // Determine type
      const type = determineType(trimmed);

      insights.push({
        type,
        text: trimmed,
        importance,
        source: file.filename,
        date: file.date,
      });
    }
  }

  // Sort by importance
  insights.sort((a, b) => b.importance - a.importance);

  const averageImportance =
    insights.length > 0
      ? insights.reduce((sum, i) => sum + i.importance, 0) / insights.length
      : 0;

  return {
    insights,
    totalExtracted: insights.length,
    averageImportance,
  };
}

function calculateImportance(text: string): number {
  let score = 0.3; // Base score

  // Check for high-importance markers
  for (const marker of IMPORTANCE_MARKERS.high) {
    if (text.includes(marker)) score += 0.4;
  }

  // Check for medium-importance markers
  for (const marker of IMPORTANCE_MARKERS.medium) {
    if (text.includes(marker)) score += 0.2;
  }

  // Check for low-importance markers
  for (const marker of IMPORTANCE_MARKERS.low) {
    if (text.includes(marker)) score += 0.1;
  }

  // Boost score for longer, detailed lines
  if (text.length > 100) score += 0.1;
  if (text.length > 200) score += 0.1;

  return Math.min(score, 1.0);
}

function determineType(
  text: string,
): "event" | "decision" | "insight" | "action" {
  for (const [type, markers] of Object.entries(TYPE_MARKERS)) {
    for (const marker of markers) {
      if (text.toLowerCase().includes(marker.toLowerCase())) {
        return type as "event" | "decision" | "insight" | "action";
      }
    }
  }
  return "insight"; // Default type
}
