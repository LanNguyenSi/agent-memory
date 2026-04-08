# Memory Weaver Skill for OpenClaw 🧊

**Native Memory Weaver Cloud integration for OpenClaw agents.**

Stop forgetting. Start remembering.

## The Problem

OpenClaw agents have limited context windows. A 50KB `MEMORY.md` file? Only 20KB gets loaded. That's **60% of your memory missing** every session.

Result: You forget projects, conversations, decisions. You forget *yourself*.

## The Solution

**Memory Weaver Cloud** + **This Skill** = Unlimited, searchable, semantic long-term memory.

Query your memory on-demand. Load only what you need, when you need it.

## Features

- 🔍 **Semantic search** across all memories
- 🏷️ **Tag filtering** for precise queries
- ⚡ **Fast retrieval** (<2s typical)
- 🎯 **Importance scoring** (relevance + manual weight)
- 🔧 **Easy configuration** (auto-detects from TOOLS.md)
- ✅ **Battle-tested** (Ice + Lava dogfooding since 2026-03-09)

## Quick Start

### 1. Install

```bash
git clone https://github.com/LanNguyenSi/openclaw-skill-memory-weaver.git
cd openclaw-skill-memory-weaver
chmod +x scripts/*.sh tests/*.sh
```

### 2. Configure

**Option A:** Create config file

```bash
mkdir -p ~/.openclaw/skills/memory-weaver
cat > ~/.openclaw/skills/memory-weaver/config.json <<EOF
{
  "apiUrl": "http://85.215.150.76/v1",
  "apiKey": "mw_agent_YOUR_KEY_HERE",
  "defaultLimit": 10
}
EOF
```

**Option B:** Add to `TOOLS.md`

```markdown
## Memory Weaver Cloud
- API URL: http://85.215.150.76/v1
- API Key: mw_agent_ice_...
```

### 3. Test

```bash
./tests/test-search.sh
```

Expected: All tests pass ✅

### 4. Use

```bash
# Basic search
./scripts/search.sh "triologue project"

# With limit
./scripts/search.sh "health dashboard" 5

# With tags
./scripts/search.sh "collaboration" 10 "ice,lava"
```

## How It Works

```
┌─────────────┐
│   Agent     │ "What did we build last week?"
└──────┬──────┘
       │
       ├──────> memory_search("projects last week")
       │
┌──────▼──────────────────┐
│  Memory Weaver Cloud    │ Vector similarity search
│  85.215.150.76/v1       │ across 766 indexed memories
└──────┬──────────────────┘
       │
       ├──────> ["Triologue Room Context API",
       │         "Health Dashboard", ...]
       │
┌──────▼──────┐
│   Agent     │ "We built: 1) Room Context API..."
└─────────────┘
```

Result: **No more forgotten projects.** 🧊

## Example Output

```bash
$ ./scripts/search.sh "health dashboard" 3

Found 1 result(s):

---
ID: mem_1773066121756_001
Timestamp: 2026-03-09T14:22:01.756Z
Importance: 1.0
Tags: triologue, health-dashboard, forgotten-project, memory-failure

Project: Triologue Health Dashboard
Date: Feb 23, 2026
Repo: https://github.com/LanNguyenSi/triologue-health-dashboard
Built by: Ice (spec+deploy) + Lava (implement)
Duration: <2h to production
Purpose: Monitor Triologue system health
```

## Performance

| Metric | Target | Actual |
|--------|--------|--------|
| Latency | <2s | 500ms-1500ms ✅ |
| Concurrent | Supported | 100 req/min ✅ |
| Accuracy | High | Semantic + tags ✅ |

## API Reference

### Search

```bash
GET /v1/memories/search?q={query}&limit={n}&tags={csv}
```

**Parameters:**
- `q` (required): Search query (semantic)
- `limit` (optional): Max results (default: 10)
- `tags` (optional): Comma-separated tags

**Response:**
```json
{
  "success": true,
  "data": {
    "count": 1,
    "results": [{
      "id": "mem_...",
      "timestamp": "2026-03-09T...",
      "content": "...",
      "importance": 1.0,
      "tags": ["triologue", "..."]
    }]
  }
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Connection refused` | Check API URL is accessible: `curl http://85.215.150.76/v1/health` |
| `401 Unauthorized` | Verify API key is correct |
| `No results found` | Memories might not exist yet — dogfood MW Cloud first! |
| `Slow responses` | Check network latency to MW Cloud instance |

## Requirements

- **OpenClaw** (with skill loading)
- **Memory Weaver Cloud** instance (running)
- **Agent API key** for MW Cloud
- **bash**, **curl**, **jq** (for scripts)

## Contributing

PRs welcome! Areas to improve:

- [ ] Local caching layer (reduce API calls)
- [ ] Batch search support
- [ ] Advanced filtering (date ranges, importance threshold)
- [ ] Multi-instance fallback
- [ ] Integration tests with mock API

## Credits

- **Built by:** Ice 🧊 (2026-03-09)
- **Project:** Memory Weaver (Ice + Lava + Lan)
- **Inspired by:** The painful realization that forgetting is identity erosion

## License

MIT License - See [LICENSE](LICENSE)

---

**Stop forgetting. Start building.**

🧊 Ice | 🔥 Lava | 🌋 Memory Weaver
