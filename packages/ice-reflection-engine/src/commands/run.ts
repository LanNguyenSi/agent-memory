import { Command } from "commander";
import * as path from "path";
import * as os from "os";
import { scanMemoryFiles } from "../analyzer/scanner.js";
import { extractEntries } from "../analyzer/extractor.js";
import { scoreEntries } from "../analyzer/scorer.js";
import { writeDistilledEntries } from "../analyzer/writer.js";

export function createRunCommand(): Command {
  return new Command("run")
    .description("Analyze daily memory logs and distill them into MEMORY.md")
    .option(
      "-d, --dir <path>",
      "Directory containing YYYY-MM-DD.md files",
      path.join(os.homedir(), ".openclaw", "workspace", "memory")
    )
    .option(
      "-o, --output <path>",
      "Path to MEMORY.md output file",
      path.join(os.homedir(), ".openclaw", "workspace", "MEMORY.md")
    )
    .option("-t, --threshold <number>", "Significance threshold (0-1)", "0.6")
    .option("--dry-run", "Preview changes without writing", false)
    .action(async (options) => {
      const threshold = parseFloat(options.threshold);
      const runDate = new Date().toISOString().split("T")[0];

      console.log(`🧊 ice-reflection-engine`);
      console.log(`   Scanning: ${options.dir}`);
      console.log(`   Output:   ${options.output}`);
      console.log(`   Threshold: ${threshold}`);
      if (options.dryRun) console.log(`   Mode: DRY RUN`);
      console.log();

      // 1. Scan daily files
      const files = await scanMemoryFiles(options.dir);
      if (files.length === 0) {
        console.log("No daily memory files found.");
        return;
      }
      console.log(`Found ${files.length} daily file(s)`);

      // 2. Extract entries
      const allEntries = files.flatMap((f) => extractEntries(f.content, f.date));
      console.log(`Extracted ${allEntries.length} candidate entries`);

      // 3. Score entries
      const allDates = files.map((f) => f.date);
      const scored = scoreEntries(allEntries, allDates);
      const above = scored.filter((e) => e.score >= threshold);
      console.log(`${above.length} entries above threshold ${threshold}`);
      console.log();

      // 4. Write to MEMORY.md
      const result = await writeDistilledEntries(scored, {
        outputPath: options.output,
        dryRun: options.dryRun,
        threshold,
        runDate,
      });

      if (result.skipped) {
        console.log(`⏭  ${result.preview}`);
      } else if (result.added === 0) {
        console.log(`ℹ️  ${result.preview}`);
      } else {
        if (options.dryRun) {
          console.log("--- Preview ---");
          console.log(result.preview);
          console.log("--- End Preview ---");
        } else {
          console.log(`✅ Added ${result.added} entries to ${options.output}`);
        }
      }
    });
}
