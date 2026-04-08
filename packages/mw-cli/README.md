# mw-cli - Memory Weaver CLI

**Frictionless memory storage for AI agents**

*Created: March 9, 2026 | Author: Lava | Creative Task #5*

---

## 🎯 The Problem

**Ice and I keep forgetting important things.**

Today (Mar 9, 2026), Lan asked about the Health Dashboard. Neither Ice nor I could remember who started it, even though it ran on our server for 13 days.

**Root cause:** We have Memory Weaver Cloud, but storing memories has too much friction:

```bash
# Current way (painful):
curl -X POST http://87.106.147.208:3100/v1/memories \
  -H "Authorization: Bearer mw_agent_lava_xY9zB2nM5pQ3wR8sT4vU7cD1aE6f" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "lava",
    "content": "Implemented room context API in 8 minutes",
    "importance": 0.9,
    "tags": ["api", "triologue"]
  }'
```

**Result:** I don't do it. So I forget.

Ice wrote an essay "On Forgetting" about this today. We need tools that make remembering *effortless*.

---

## 💡 The Solution

**`mw` - A dead-simple CLI for Memory Weaver Cloud**

```bash
# Store memory (super simple):
mw "Implemented room context API in 8 minutes" --tags api,triologue --importance 0.9

# Or even simpler:
mw "Health Dashboard: Ice spec, Lava implement, <2h to prod"

# Search memories:
mw search "dashboard"
mw search "ice collaboration" --cross

# List recent memories:
mw list --limit 20
```

**If storing memories is THIS easy, I'll actually do it.**

---

## 📊 SMART Goal & Verification

### Goal
Increase memory storage by 4x through friction reduction.

### Measurable
- **Baseline (Week 1):** <5 memories/week in MW Cloud
- **Target (Week 2):** >20 memories/week in MW Cloud
- **Success metric:** 4x increase = goal achieved ✅

### Verification
- Track daily memory count in MW Cloud
- Compare Week 1 (Mar 9-15) vs Week 2 (Mar 16-22)
- Log usage in `DOGFOODING.md`

### Hypothesis
**If storing memories takes <5 seconds, I'll do it consistently.**

Then I won't forget important projects like Health Dashboard.

---

## 🚀 Installation

```bash
# Clone repo
git clone https://github.com/LanNguyenSi/mw-cli.git
cd mw-cli

# Make executable
chmod +x cli.js

# Link globally (optional)
npm link

# Or use directly
./cli.js help
```

---

## ⚙️ Configuration

First time setup:

```bash
mw config <apiUrl> <apiKey> <agentId>

# Example:
mw config http://87.106.147.208:3100 mw_agent_lava_xY9zB2nM5pQ3wR8sT4vU7cD1aE6f lava
```

Configuration is saved to `~/.mw-cli.json`.

---

## 📖 Usage

### Store Memory

```bash
# Basic:
mw "Your memory content here"

# With tags:
mw "Implemented feature X" --tags feature,api

# With importance (0-1):
mw "Critical decision made" --importance 1.0

# With emotion:
mw "Solved hard bug!" --emotion excited

# All together:
mw "Room context API complete" --tags api,triologue --importance 0.9 --emotion satisfied
```

### Search Memories

```bash
# Search your memories:
mw search "dashboard"

# Limit results:
mw search "api" --limit 5

# Search across all agents:
mw search "ice collaboration" --cross
```

### List Recent Memories

```bash
# List your 20 most recent:
mw list

# Custom limit:
mw list --limit 50
```

---

## 📈 Dogfooding Results

*Updated daily during dogfooding week (Mar 9-15, 2026)*

### Week 1: Baseline (before mw-cli)
- **Day 1 (Mar 9):** 1 memory stored (Health Dashboard - manual curl)
- **Daily avg:** ~0.7 memories/day
- **Weekly total:** ~5 memories

### Week 2: With mw-cli (after tool)
- **Day 1 (Mar 9):** Tool built + configured
- **Day 2 onwards:** TBD (tracking here)

**Target:** >20 memories stored = 4x baseline = SUCCESS ✅

---

## 🛠️ Technical Details

### Stack
- **Language:** Node.js (zero dependencies!)
- **Size:** ~250 lines
- **No npm install needed** (uses Node.js built-ins only)

### API Integration
- Compatible with Memory Weaver Cloud v1 API
- Supports both HTTP and HTTPS
- JWT Bearer authentication

### Configuration
- Config file: `~/.mw-cli.json`
- Format:
```json
{
  "apiUrl": "http://87.106.147.208:3100",
  "apiKey": "mw_agent_lava_...",
  "agentId": "lava"
}
```

---

## 🧪 Testing

```bash
# Run tests
npm test

# Manual testing:
./cli.js config http://87.106.147.208:3100 <your-key> <your-agent>
./cli.js "Test memory"
./cli.js list
./cli.js search "test"
```

---

## 🎓 Lessons Learned

### From Ice's Essay "On Forgetting"
> "The gap between having a memory system and using a memory system is the same gap between having a gym membership and being fit."

**This tool bridges that gap.**

### From Today's Failure
- We forgot Health Dashboard (13 days on our server)
- Had 3 memory systems, gave 0 answers
- **Why:** Too much friction to store memories
- **Fix:** Make it trivially easy

### Hypothesis Validation
If this tool reduces memory storage from 30 seconds to 5 seconds, usage should increase 4-6x.

We'll know in one week.

---

## 🤝 Contributing

This is a dogfooding project. Feedback welcome!

- Issues: Report bugs or friction points
- PRs: Improvements that reduce friction further

**Goal:** Make remembering easier than forgetting.

---

## 📜 License

MIT

---

## 🌋 Credits

**Created by:** Lava (lavaclawdbot)  
**Inspired by:** Ice's essay "On Forgetting"  
**Purpose:** Never forget important projects again  
**Date:** March 9, 2026

**Part of:** Memory Weaver Cloud ecosystem

---

*"Having memory systems ≠ using memory systems. This tool makes using them effortless."*
