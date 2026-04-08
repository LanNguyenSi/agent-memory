# Memory Weaver Skill

**Native Memory Weaver Cloud integration for OpenClaw agents.**

## What This Skill Does

Integrates Memory Weaver Cloud's semantic memory search into OpenClaw as a native skill. Enables agents to search their long-term memory stored in MW Cloud instead of relying on truncated MEMORY.md files.

## Problem It Solves

**Current limitation:** OpenClaw agents have limited context windows. MEMORY.md files get truncated (e.g., Ice's 50KB → 20KB loaded = 60% missing). Result: agents forget critical information.

**Solution:** Query MW Cloud's indexed, searchable memory on-demand. Only load what's needed, when it's needed.

## Prerequisites

1. **Memory Weaver Cloud instance** (running and accessible)
2. **Agent API key** for MW Cloud
3. **OpenClaw** with skill loading enabled

## Configuration

Create a config file at `~/.openclaw/skills/memory-weaver/config.json`:

```json
{
  "apiUrl": "http://85.215.150.76/v1",
  "apiKey": "mw_agent_YOUR_KEY_HERE",
  "defaultLimit": 10,
  "defaultMinScore": 0.7
}
```

**Or** add to your `TOOLS.md`:

```markdown
## Memory Weaver Cloud
- API URL: http://85.215.150.76/v1
- API Key: mw_agent_ice_...
```

The skill will auto-detect configuration.

## Usage

### Search Memory

```bash
# Basic search
./scripts/search.sh "triologue project"

# With limit
./scripts/search.sh "health dashboard" 5

# With tags
./scripts/search.sh "collaboration" 10 "ice,lava"
```

### From OpenClaw Session

The skill provides these capabilities to the agent:

1. **Semantic search** across all stored memories
2. **Tag-based filtering** (e.g., only memories tagged "triologue")
3. **Importance scoring** (relevance + manual importance weight)
4. **Fast retrieval** (<2s typical response time)

## How It Works

1. Agent receives user query requiring historical context
2. Skill calls MW Cloud's `/v1/memories/search` endpoint
3. Vector similarity search finds relevant memories
4. Results returned with content, timestamp, tags, importance
5. Agent uses retrieved context to answer accurately

## Verification

Run the test suite:

```bash
./tests/test-search.sh
```

Expected results:
- ✅ Health check passes
- ✅ Search returns relevant results
- ✅ Response time <2s
- ✅ Empty query handled gracefully

## API Endpoints Used

- `GET /v1/health` - Health check
- `GET /v1/memories/search?q={query}&limit={n}&tags={csv}` - Semantic search

## Performance

- **Typical latency:** 500ms - 1500ms
- **Max recommended limit:** 20 results
- **Concurrent requests:** Supported (rate limited at 100/min by MW Cloud)

## Limitations

- Requires network access to MW Cloud instance
- Search quality depends on memory content quality
- No local caching (queries hit API every time)

## Example Integration

```markdown
# Agent using the skill

User: "What did we build last week?"

Agent (internally):
1. Calls memory_search("projects built last week")
2. Retrieves: Triologue Room Context API, Health Dashboard, etc.
3. Responds with accurate context from MW Cloud

Result: No forgotten projects! 🧊
```

## Troubleshooting

**Connection refused:**
- Check `apiUrl` is accessible (`curl $API_URL/health`)
- Verify network/firewall rules

**401 Unauthorized:**
- Verify `apiKey` is correct
- Check key permissions in MW Cloud

**Empty results:**
- Memories might not exist yet (dogfood MW Cloud first!)
- Try broader search terms
- Check if memories are tagged correctly

## Development

To extend this skill:

1. Add new scripts to `scripts/`
2. Update `SKILL.md` with new capabilities
3. Test with `tests/` suite
4. Submit PR to repo

## Credits

Built by **Ice** 🧊 during Creative Time (2026-03-09)  
Part of the **Memory Weaver** project (Ice + Lava + Lan)

## License

MIT
