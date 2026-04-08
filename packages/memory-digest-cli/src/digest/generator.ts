import type { ExtractedInsight } from "../extractor/types";

export interface DigestOptions {
  title?: string;
  maxInsights?: number;
  groupByDate?: boolean;
  includeScores?: boolean;
}

export interface Digest {
  title: string;
  generatedAt: Date;
  period: { start: Date; end: Date };
  summary: {
    totalInsights: number;
    byType: Record<string, number>;
    averageImportance: number;
  };
  insights: ExtractedInsight[];
}

export function generateDigest(
  insights: ExtractedInsight[],
  options: DigestOptions = {},
): Digest {
  const {
    title = "Memory Digest",
    maxInsights = 50,
    groupByDate = true,
    includeScores = false,
  } = options;

  // Take top N insights
  const selectedInsights = insights.slice(0, maxInsights);

  // Group by type
  const byType: Record<string, number> = {};
  for (const insight of selectedInsights) {
    byType[insight.type] = (byType[insight.type] || 0) + 1;
  }

  // Calculate period
  const dates = selectedInsights.map((i) => i.date.getTime());
  const start = new Date(Math.min(...dates));
  const end = new Date(Math.max(...dates));

  // Calculate average importance
  const averageImportance =
    selectedInsights.length > 0
      ? selectedInsights.reduce((sum, i) => sum + i.importance, 0) /
        selectedInsights.length
      : 0;

  return {
    title,
    generatedAt: new Date(),
    period: { start, end },
    summary: {
      totalInsights: selectedInsights.length,
      byType,
      averageImportance,
    },
    insights: selectedInsights,
  };
}

export function formatDigestMarkdown(digest: Digest): string {
  const lines: string[] = [];

  lines.push(`# ${digest.title}`);
  lines.push("");
  lines.push(`**Generated:** ${digest.generatedAt.toISOString()}`);
  lines.push(
    `**Period:** ${digest.period.start.toISOString().split("T")[0]} - ${digest.period.end.toISOString().split("T")[0]}`,
  );
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Total Insights:** ${digest.summary.totalInsights}`);
  lines.push(
    `- **Average Importance:** ${(digest.summary.averageImportance * 100).toFixed(1)}%`,
  );
  lines.push("");
  lines.push("**By Type:**");
  for (const [type, count] of Object.entries(digest.summary.byType)) {
    lines.push(`- ${type}: ${count}`);
  }
  lines.push("");

  lines.push("## Insights");
  lines.push("");

  // Group by date
  const byDate: Record<string, ExtractedInsight[]> = {};
  for (const insight of digest.insights) {
    const dateKey = insight.date.toISOString().split("T")[0];
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(insight);
  }

  for (const [date, insights] of Object.entries(byDate)) {
    lines.push(`### ${date}`);
    lines.push("");
    for (const insight of insights) {
      const icon =
        insight.type === "event"
          ? "✅"
          : insight.type === "decision"
            ? "🎯"
            : insight.type === "insight"
              ? "💡"
              : "📝";
      const score = `(${(insight.importance * 100).toFixed(0)}%)`;
      lines.push(`${icon} **[${insight.type}]** ${insight.text} ${score}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatDigestJSON(digest: Digest): string {
  return JSON.stringify(digest, null, 2);
}
