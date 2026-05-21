# memory-digest-cli

A CLI tool to generate daily memory digests from markdown files. It scans dated `YYYY-MM-DD.md` files and extracts events, decisions, and insights into a summary report.

## Overview

`memory-digest-cli` scans directories containing daily memory files (`YYYY-MM-DD.md` format), extracts important events, decisions, and insights, and generates structured digest reports. It is useful for agents managing long-term memory and for developers tracking daily logs.

## Features

- 📁 **Smart Scanning**: Finds and parses YYYY-MM-DD.md files with configurable date ranges
- 🧠 **Insight Extraction**: Automatically detects events, decisions, insights, and actions
- 📊 **Importance Scoring**: Ranks insights by importance using marker-based heuristics
- 📝 **Multiple Output Formats**: Markdown and JSON export
- ⚡ **Fast Processing**: Handles large memory file sets efficiently
- 🔍 **Recursive Scanning**: Optional subdirectory traversal

## Installation

### From source

```bash
git clone https://github.com/LanNguyenSi/memory-digest-cli.git
cd memory-digest-cli
npm install
npm run build
```

### Using the CLI

```bash
# Run directly with Node
node dist/src/main.js generate --help

# Or use npm scripts
npm run dev -- generate --help
```

## Quick Start

Generate a digest from your memory files:

```bash
# Basic usage - scan current directory for last 7 days
node dist/src/main.js generate

# Scan specific directory for last 3 days
node dist/src/main.js generate --dir ./memory --days 3

# Limit to top 10 insights and output JSON
node dist/src/main.js generate --dir ./memory --max 10 --json

# Save to file
node dist/src/main.js generate --dir ./memory --output digest.md

# Scan subdirectories recursively
node dist/src/main.js generate --dir ./memory --recursive
```

## CLI Options

### `generate` command

```
Options:
  -d, --dir <directory>   Directory to scan (default: current directory)
  -o, --output <file>     Output file (default: stdout)
  --days <number>         Number of days to look back (default: 7)
  --max <number>          Maximum insights to include (default: 50)
  --recursive             Scan subdirectories recursively
  --json                  Output in JSON format
  -h, --help              Display help
```

## Memory File Format

Memory files should follow this naming convention:

```
YYYY-MM-DD.md
```

Examples:

- `2026-03-26.md`
- `2026-03-25.md`

### Importance Markers

The tool recognizes these markers for importance scoring:

**High importance:**

- ✅ `COMPLETE`, `SUCCESS`, `BREAKTHROUGH`, `CRITICAL`
- 🎉 Major achievements
- 🚀 Launches and deployments

**Medium importance:**

- ✓ `IMPORTANT`, `NOTE`, `DECISION`
- 🔥 Significant events

**Low importance:**

- ⚠️ Warnings
- 💭 Ideas and considerations

### Type Detection

Insights are automatically categorized as:

- **event**: Completed actions (✅, finished, deployed)
- **decision**: Choices made (decided, chose, will)
- **insight**: Learnings (learned, realized, discovered, 💡)
- **action**: TODOs (need to, must, should, [ ])

## Example Output

### Markdown Format

```markdown
# Memory Digest

**Generated:** 2026-03-26T19:30:00.000Z
**Period:** 2026-03-24 - 2026-03-26

## Summary

- **Total Insights:** 15
- **Average Importance:** 67.3%

**By Type:**

- event: 6
- decision: 4
- insight: 3
- action: 2

## Insights

### 2026-03-26

✅ **[event]** Completed memory-digest-cli implementation (90%)
🎯 **[decision]** Decided to use TypeScript for better type safety (75%)
💡 **[insight]** Learned that importance scoring improves digest quality (68%)
```

### JSON Format

```json
{
  "title": "Memory Digest",
  "generatedAt": "2026-03-26T19:30:00.000Z",
  "period": {
    "start": "2026-03-24T00:00:00.000Z",
    "end": "2026-03-26T00:00:00.000Z"
  },
  "summary": {
    "totalInsights": 15,
    "byType": {
      "event": 6,
      "decision": 4,
      "insight": 3,
      "action": 2
    },
    "averageImportance": 0.673
  },
  "insights": [...]
}
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- generate --dir ./test-data

# Type check
npm run typecheck

# Build
npm run build

# Run tests
npm test
```

## Architecture

- `src/scanner/`: File scanning and date filtering
- `src/extractor/`: Insight extraction and importance scoring
- `src/digest/`: Digest generation and formatting
- `src/commands/`: CLI command implementations

## Use Cases

### AI Agents

Digest daily memory files into concise summaries for quick context recovery after a restart.

### Developers

Track daily logs and extract key decisions, learnings, and TODOs from markdown journals.

## Compatibility

- **Memory files**: Reads daily memory files in `YYYY-MM-DD.md` format
- **Node.js**: Requires Node.js ≥20
- **TypeScript**: Written in TypeScript for type safety

## License

MIT

## Contributing

Contributions are welcome. Open an issue or a pull request.
