# ice-reflection-engine

A TypeScript CLI that analyzes an AI agent's daily memory logs and distills them into structured long-term memory entries. Reads YYYY-MM-DD.md files, identifies patterns and decisions, and writes curated summaries to MEMORY.md using semantic scoring.

## Overview

`ice-reflection-engine` is a command-line tool built with **typescript** and **commander**.
It is distributed as a self-contained binary.

## Installation

### Download pre-built binary

Download the latest release from the [releases page](https://github.com/your-org/ice-reflection-engine/releases).

```bash
# Linux / macOS
curl -sSL https://github.com/your-org/ice-reflection-engine/releases/latest/download/ice-reflection-engine-$(uname -s | tr '[:upper:]' '[:lower:]')-amd64 -o /usr/local/bin/ice-reflection-engine
chmod +x /usr/local/bin/ice-reflection-engine
```

### From source

```bash
git clone https://github.com/your-org/ice-reflection-engine.git
cd ice-reflection-engine
```

## Quick Start

```bash
# Show help
ice-reflection-engine --help

# Show version
ice-reflection-engine --version

# Run the default command
ice-reflection-engine run

# Get help for a subcommand
ice-reflection-engine run --help
```

## Usage

### Global Options

| Option | Description |
|--------|-------------|
| `--help` | Show help and exit |
| `--version` | Show version and exit |
| `--config PATH` | Path to config file (default: `~/.config/ice-reflection-engine/config.json`) |
| `--verbose` | Enable verbose output |
| `--quiet` | Suppress non-error output |
| `--no-color` | Disable colored output |

### Commands

#### `ice-reflection-engine run`

Execute the primary action.

```bash
ice-reflection-engine run [OPTIONS] [ARGS]...

Options:
  --dry-run   Show what would happen without making changes
  --output    Output format: text, json, yaml  [default: text]
  --help      Show this message and exit
```

#### `ice-reflection-engine config`

Manage tool configuration.

```bash
ice-reflection-engine config show              # Print current config
ice-reflection-engine config set KEY VALUE     # Set a config value
ice-reflection-engine config get KEY           # Get a config value
ice-reflection-engine config reset             # Reset to defaults
```

#### `ice-reflection-engine version`

Show detailed version information.

```bash
ice-reflection-engine version
# ice-reflection-engine v0.1.0
# Language: typescript
# Framework: commander
# Build: (commit hash)
```

## Configuration

ice-reflection-engine stores configuration at:

- **Linux/macOS**: `~/.config/ice-reflection-engine/config.json`
- **Windows**: `%APPDATA%\ice-reflection-engine\config.json`

The `--config` flag overrides the default path.

### Example config file

```json
{
  "output_format": "text",
  "color": true,
  "verbose": false
}
```

### Environment Variables

All config keys can be overridden via environment variables prefixed with `ICE_REFLECTION_ENGINE_`:

```bash
export ICE_REFLECTION_ENGINE_OUTPUT_FORMAT=json
export ICE_REFLECTION_ENGINE_VERBOSE=true
```

Priority order (highest to lowest): CLI flags > environment variables > config file > defaults.

## Project Structure

```
ice-reflection-engine/
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
git clone https://github.com/your-org/ice-reflection-engine.git
cd ice-reflection-engine
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

Strategy: **unit-tests**

Tests cover individual commands, argument parsing, config loading, and output formatting.
Run them with the command shown in the Development section above.

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
