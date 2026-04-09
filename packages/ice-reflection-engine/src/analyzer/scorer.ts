import type { Entry } from "./extractor.js";

const TYPE_WEIGHTS: Record<Entry["type"], number> = {
  decision: 0.9,
  lesson: 0.85,
  insight: 0.75,
  event: 0.6,
};

// Higher-value keywords boost score
const KEYWORD_BOOSTS: [RegExp, number][] = [
  [/\b(critical|important|key|major|significant)\b/i, 0.15],
  [/\b(always|never|remember|don't forget)\b/i, 0.1],
  [/\b(bug|fix|error|crash|broke)\b/i, 0.05],
];

export interface ScoredEntry extends Entry {
  score: number;
}

export function scoreEntries(entries: Entry[], allDates: string[]): ScoredEntry[] {
  const latestDate = allDates[allDates.length - 1] ?? "";

  return entries.map((entry) => {
    let score = TYPE_WEIGHTS[entry.type];

    // Recency boost: entries from the latest date get +0.1
    const daysDiff = dateDiffDays(entry.date, latestDate);
    const recencyBoost = Math.max(0, 0.1 - daysDiff * 0.01);
    score += recencyBoost;

    // Keyword boosts
    for (const [pattern, boost] of KEYWORD_BOOSTS) {
      if (pattern.test(entry.text)) score += boost;
    }

    return { ...entry, score: Math.min(1, score) };
  });
}

function dateDiffDays(dateA: string, dateB: string): number {
  try {
    const a = new Date(dateA).getTime();
    const b = new Date(dateB).getTime();
    return Math.abs(Math.round((b - a) / 86400000));
  } catch {
    return 0;
  }
}
