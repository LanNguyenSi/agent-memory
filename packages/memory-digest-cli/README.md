# memory-digest-cli

A CLI tool that scans dated `YYYY-MM-DD.md` memory files and generates a
digest of events, decisions, and insights.

> **Internal tool: not published to npm.** This CLI is used from source
> within this repo and is intentionally not a published package
> (`private: true`); this repo publishes only `@lannguyensi/memory-router`.
> Build and run it from the monorepo rather than installing from npm.

## Overview

`memory-digest-cli` scans a directory of daily memory files
(`YYYY-MM-DD.md`), extracts lines that look like events, decisions, or
insights using marker-based heuristics, and renders a Markdown or JSON
digest. It is useful for agents recovering context after a restart, and
for developers skimming daily logs.

## Key features

- Scans `YYYY-MM-DD.md` files within a configurable day range
- Recursive subdirectory scanning (`--recursive`)
- Marker-based importance scoring and event/decision/insight/action
  classification
- Markdown or JSON output, to stdout or a file

## Install / quick start

Requires Node.js 20 or newer. Not published to npm; build from source:

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/memory-digest-cli
npm install
npm run build
```

Run the built CLI, or use it in development without building:

```bash
node dist/main.js generate --help
npm run dev -- generate --help
```

## Usage

```bash
# Scan the current directory for the last 7 days (defaults)
node dist/main.js generate

# Scan a specific directory for the last 3 days, JSON output
node dist/main.js generate --dir ./memory --days 3 --json

# Save the digest to a file instead of stdout
node dist/main.js generate --dir ./memory --output digest.md
```

See [docs/reference.md](docs/reference.md) for the full `generate` option
list, the memory file format, and the importance/type heuristics.

## Documentation

- [docs/reference.md](docs/reference.md) - CLI options, memory file format, importance scoring, type detection, example output
- [docs/architecture.md](docs/architecture.md) - internal structure, exit codes, all registered commands
- [docs/ways-of-working.md](docs/ways-of-working.md) - contribution conventions and definition of done

## Development

```bash
npm install
npm run dev -- generate --dir ./test-data
npm run typecheck
npm run build
npm test
```

See [docs/ways-of-working.md](docs/ways-of-working.md) for contribution
guidelines.

## License

MIT. See [LICENSE](../../LICENSE).
