export interface ExtractedInsight {
  type: "event" | "decision" | "insight" | "action";
  text: string;
  importance: number; // 0-1 score
  source: string; // filename
  date: Date;
}

export interface ExtractionResult {
  insights: ExtractedInsight[];
  totalExtracted: number;
  averageImportance: number;
}
