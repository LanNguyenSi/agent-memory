import * as fs from "fs/promises";
import { Command } from "commander";
import { scanMemoryFiles } from "../scanner/scanner.js";
import { extractInsights } from "../extractor/extractor.js";
import {
  generateDigest,
  formatDigestMarkdown,
  formatDigestJSON,
} from "../digest/generator.js";

export function registerGenerateCommand(program: Command) {
  program
    .command("generate")
    .description("Generate a memory digest from markdown files")
    .option("-d, --dir <directory>", "Directory to scan", process.cwd())
    .option(
      "-o, --output <file>",
      "Output file (default: stdout, use .json for JSON format)",
    )
    .option("--days <number>", "Number of days to look back", "7")
    .option("--max <number>", "Maximum insights to include", "50")
    .option("--recursive", "Scan subdirectories recursively", false)
    .option("--json", "Output in JSON format", false)
    .action(async (options) => {
      try {
        // Scan memory files
        console.error(`Scanning ${options.dir}...`);
        const scanResult = await scanMemoryFiles({
          directory: options.dir,
          daysBack: parseInt(options.days),
          recursive: options.recursive,
        });

        console.error(
          `Found ${scanResult.totalMatched} files (scanned ${scanResult.totalScanned})`,
        );

        if (scanResult.errors.length > 0) {
          console.error(`Warnings: ${scanResult.errors.length}`);
          for (const error of scanResult.errors) {
            console.error(`  - ${error}`);
          }
        }

        // Extract insights
        console.error("Extracting insights...");
        const extractionResult = extractInsights(scanResult.files);
        console.error(`Extracted ${extractionResult.totalExtracted} insights`);

        // Generate digest
        console.error("Generating digest...");
        const digest = generateDigest(extractionResult.insights, {
          maxInsights: parseInt(options.max),
        });

        // Format output
        const output = options.json
          ? formatDigestJSON(digest)
          : formatDigestMarkdown(digest);

        // Write or print
        if (options.output) {
          await fs.writeFile(options.output, output, "utf-8");
          console.error(`Digest written to ${options.output}`);
        } else {
          console.log(output);
        }
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
}
