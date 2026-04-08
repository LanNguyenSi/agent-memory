# agent-memory-sync

A CLI tool that syncs agent memory files across multiple OpenClaw instances via a central Git repository. It supports push, pull, full sync, inline conflict handling, offline queueing, cron-compatible scheduling, and dry-run previews.

## Overview

`agent-memory-sync` is a command-line tool built with **typescript** and **commander**.
It is distributed as a self-contained binary.

## Installation

### Download pre-built binary

Download the latest release from the [releases page](https://github.com/LanNguyenSi/agent-memory-sync/releases).

```bash
# Linux / macOS
curl -sSL https://github.com/LanNguyenSi/agent-memory-sync/releases/latest/download/agent-memory-sync-$(uname -s | tr '[:upper:]' '[:lower:]')-amd64 -o /usr/local/bin/agent-memory-sync
chmod +x /usr/local/bin/agent-memory-sync
```

### From source

```bash
git clone https://github.com/LanNguyenSi/agent-memory-sync.git
cd agent-memory-sync
```

## Quick Start

```bash
# Show help
agent-memory-sync --help

# Show version
agent-memory-sync --version

# Run a full sync with the default profile
agent-memory-sync run

# Push only
agent-memory-sync run --mode push

# Pull only
agent-memory-sync run --mode pull

# Preview changes without writing locally or remotely
agent-memory-sync run --dry-run

# Get help for a subcommand
agent-memory-sync run --help
```

## Usage

### Global Options

| Option | Description |
|--------|-------------|
| `--help` | Show help and exit |
| `--version` | Show version and exit |
| `--config PATH` | Path to config file (default: `~/.config/agent-memory-sync/config.json`) |
| `--verbose` | Enable verbose output |
| `--quiet` | Suppress non-error output |
| `--no-color` | Disable colored output |

### Commands

#### `agent-memory-sync run [profile]`

Execute a sync profile.

```bash
agent-memory-sync run [profile] [OPTIONS]

Options:
  --mode <sync|push|pull>                Action to perform  [default: sync]
  --remote <url>                         Override remote Git repository URL
  --branch <name>                        Override branch  [default: main]
  --repository-subdir <path>             Override remote subdirectory
  --root-dir <path>                      Override workspace root
  --state-dir <path>                     Override local state directory
  --schedule "<cron expression>"         Run on a 5-field cron-compatible schedule
  --max-runs <count>                     Limit scheduled runs
  --conflict-strategy <strategy>         inline-markers, local-wins, remote-wins
  --dry-run                              Show what would happen without making changes
  --output <text|json|yaml>              Output format  [default: text]
  --verbose                              Enable verbose diagnostics
  --quiet                                Suppress non-error diagnostics
  --no-color                             Disable colored diagnostics
  --help                                 Show this message and exit
```

#### `agent-memory-sync config`

Manage tool configuration.

```bash
agent-memory-sync config show              # Print current config
agent-memory-sync config set KEY VALUE     # Set a config value
agent-memory-sync config get KEY           # Get a config value
agent-memory-sync config reset             # Remove persisted config
```

#### `agent-memory-sync version`

Show detailed version information.

```bash
agent-memory-sync version
# agent-memory-sync v0.1.0
# Language: typescript
# Framework: commander
# Build: (commit hash)
```

## Configuration

agent-memory-sync stores configuration at:

- **Linux/macOS**: `~/.config/agent-memory-sync/config.json`
- **Windows**: `%APPDATA%\agent-memory-sync\config.json`

The `--config` flag overrides the default path.

### Example config file

```json
{
  "rootDir": "/home/user/agent-workspace",
  "remoteUrl": "/srv/git/agent-memory.git",
  "branch": "main",
  "repositorySubdir": "shared",
  "stateDir": ".agent-memory-sync/default",
  "schedule": "*/15 * * * *",
  "conflictStrategy": "inline-markers",
  "outputFormat": "text",
  "verbose": false,
  "syncPaths": [
    { "source": "MEMORY.md", "destination": "MEMORY.md", "kind": "file" },
    { "source": "logs", "destination": "logs", "kind": "directory" }
  ]
}
```

### Environment Variables

All config keys can be overridden via environment variables prefixed with `AGENT_MEMORY_SYNC_`:

```bash
export AGENT_MEMORY_SYNC_REMOTE_URL=/srv/git/agent-memory.git
export AGENT_MEMORY_SYNC_OUTPUT_FORMAT=json
export AGENT_MEMORY_SYNC_VERBOSE=true
```

Priority order (highest to lowest): CLI flags > environment variables > config file > defaults.

### Sync behavior

- `sync` runs `pull` first and then `push`
- failed pushes are queued locally in `stateDir/queue` and replayed on the next successful push
- append-only concurrent edits are merged automatically; other conflicts default to inline conflict markers
- `--dry-run` previews the result without changing local files or the remote repository

## Project Structure

```
agent-memory-sync/
├── src/
│   ├── commands/         # One file per subcommand
│   ├── config/           # Config loading and validation
│   └── main.ts
├── tests/
│   └── ...               # Test files mirroring src/
├── docs/
│   ├── architecture.md
│   ├── ways-of-working.md
│   └── adrs/
├── AI_CONTEXT.md
└── README.md
```

## Development

### Prerequisites

- Node.js 20+
- npm or pnpm

### Setup

```bash
git clone https://github.com/LanNguyenSi/agent-memory-sync.git
cd agent-memory-sync
npm install
npm run build
```

### Running Tests

```bash
npm test
npm run test:coverage
```

### Linting and Formatting

```bash
npm run lint
npm run format
```

## CI/CD

Continuous integration runs on every pull request and push to `main`:

- Lint and format check
- Unit tests
- Build verification
- Cross-platform build (Linux, macOS, Windows)

See `.github/workflows/` for pipeline definitions.

## Testing

Strategy: **integration-tests**

Tests invoke the compiled binary and assert on exit codes and stdout/stderr.
Run them after building the project.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes with tests
4. Run the full test suite
5. Open a pull request

See [ways-of-working](docs/ways-of-working.md) for full contribution guidelines.

## License

MIT License. See [LICENSE](LICENSE) for details.

---

*Generated with [ScaffoldKit](https://github.com/LanNguyenSi/scaffoldkit)*
