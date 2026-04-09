import * as fs from "fs/promises";
import * as path from "path";

const DATE_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

export interface DailyFile {
  date: string;
  path: string;
  content: string;
}

export async function scanMemoryFiles(dir: string): Promise<DailyFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: DailyFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !DATE_FILE_PATTERN.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const content = await fs.readFile(filePath, "utf-8");
    files.push({
      date: entry.name.replace(".md", ""),
      path: filePath,
      content,
    });
  }

  return files.sort((a, b) => a.date.localeCompare(b.date));
}
