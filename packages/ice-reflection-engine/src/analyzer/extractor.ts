export interface Entry {
  text: string;
  type: "decision" | "lesson" | "event" | "insight";
  date: string;
  lineIndex: number;
}

// Heuristic patterns for each entry type
const PATTERNS: Record<Entry["type"], RegExp[]> = {
  decision: [
    /\b(decided|chose|picked|selected|opted|going with|will use)\b/i,
    /\b(decision:|approach:|strategy:)\b/i,
  ],
  lesson: [
    /\b(learned|discovered|realized|found out|turns out|important:|note:)\b/i,
    /\b(lesson:|takeaway:|key insight:)\b/i,
    /\b(should have|should not|always|never again)\b/i,
  ],
  insight: [
    /\b(breakthrough|aha|interesting|surprising|unexpected)\b/i,
    /\b(pattern:|observation:|insight:)\b/i,
  ],
  event: [
    /\b(completed|finished|deployed|released|merged|fixed|resolved|shipped)\b/i,
    /\b(milestone:|achievement:|done:)\b/i,
  ],
};

export function extractEntries(content: string, date: string): Entry[] {
  const lines = content.split("\n");
  const entries: Entry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.length < 20) continue;

    for (const [type, patterns] of Object.entries(PATTERNS) as [Entry["type"], RegExp[]][]) {
      if (patterns.some((p) => p.test(line))) {
        entries.push({ text: line, type, date, lineIndex: i });
        break;
      }
    }
  }

  return entries;
}
