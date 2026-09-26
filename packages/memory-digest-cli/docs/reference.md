# memory-digest-cli reference

Full CLI option reference, the memory-file format, and the marker-based
importance/type heuristics for the `generate` command. See the
[README](../README.md) for install and a quick-start example.

## `generate` options

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

`--output` writes the same content `generate` would print to stdout; the
output format is controlled by `--json`, not by the output file's
extension.

## Memory file format

Memory files must be named `YYYY-MM-DD.md`, for example `2026-03-26.md`.
Files older than `--days` (default 7, counted from the current date) are
skipped. Any other filename is ignored, recursively when `--recursive` is
set.

## Importance scoring

Every non-empty, non-heading line at least 10 characters long starts at a
base score of 0.3 and is scanned for these markers (`src/extractor/extractor.ts`):

- High (+0.4 each): `COMPLETE`, `SUCCESS`, `BREAKTHROUGH`, `CRITICAL`, plus the emoji `✅`, `🎉`, `🚀`
- Medium (+0.2 each): `IMPORTANT`, `NOTE`, `DECISION`, `TODO`, plus the emoji `✓`, `🔥`
- Low (+0.1 each): `idea`, `consider`, plus the emoji `⚠️`, `💭`

A line over 100 characters gets +0.1, and one over 200 characters gets a
further +0.1. The score is capped at 1.0. Lines scoring below 0.3 are
dropped; `--max` then caps how many of the remaining, importance-sorted
insights are kept.

## Type detection

Each kept line is classified by the first matching keyword (case-insensitive),
checked in this order; a line matching none of them defaults to `insight`:

- **event**: `happened`, `completed`, `finished`, `deployed`, `launched`, `✅`, `🎉`
- **decision**: `decided`, `chose`, `will`, `going to`, `DECISION`
- **insight**: `learned`, `realized`, `discovered`, `found`, `💡`, `insight`
- **action**: `TODO`, `need to`, `must`, `should`, `[ ]`

## Example output

### Markdown

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

Each insight line is prefixed by a per-type icon (`formatDigestMarkdown` in
`src/digest/generator.ts`): `✅` event, `🎯` decision, `💡` insight, `📝` action.

### JSON

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

## Undocumented commands

The CLI also registers `run` and `config show` (`src/commands/run.ts`,
`src/commands/config.ts`); they exist in source and are covered in
[docs/architecture.md](architecture.md), but are not part of this
package's documented, supported surface (no consumer uses them; see
`memory-digest-cli`'s `package.json` posture note). Not covered here.
