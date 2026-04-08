#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CONFIG_PATH = path.join(process.env.HOME, '.mw-cli.json');

// Load config
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ Config not found. Run: mw config');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Save config
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`✅ Config saved to ${CONFIG_PATH}`);
}

// HTTP request helper
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    const req = client.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data });
        }
      });
    });
    
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Store memory
async function store(content, options) {
  const config = loadConfig();
  const { apiUrl, apiKey, agentId } = config;
  
  const tags = options.tags ? options.tags.split(',').map(t => t.trim()) : [];
  const importance = parseFloat(options.importance || 0.8);
  
  const body = {
    agentId,
    content,
    importance,
    tags
  };
  
  if (options.emotion) body.emotion = options.emotion;
  
  try {
    const res = await request(`${apiUrl}/v1/memories`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }, body);
    
    if (res.data.success) {
      console.log(`✅ Memory stored: ${res.data.data.id}`);
      console.log(`   Tags: ${tags.join(', ') || 'none'}`);
      console.log(`   Importance: ${importance}`);
    } else {
      console.error('❌ Failed:', res.data.error?.message || 'Unknown error');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Request failed:', err.message);
    process.exit(1);
  }
}

// Search memories
async function search(query, options) {
  const config = loadConfig();
  const { apiUrl, apiKey, agentId } = config;
  
  const limit = options.limit || 10;
  const searchAgentId = options.cross ? undefined : agentId;
  
  const params = new URLSearchParams({
    q: query,
    limit: limit.toString()
  });
  
  if (searchAgentId) params.append('agentId', searchAgentId);
  
  try {
    const res = await request(`${apiUrl}/v1/memories/search?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    if (res.data.success) {
      const results = res.data.data.results || [];
      console.log(`\n🔍 Found ${results.length} memories:\n`);
      
      results.forEach((mem, i) => {
        console.log(`${i + 1}. [${mem.agent || mem.agentId}] ${mem.content.substring(0, 100)}${mem.content.length > 100 ? '...' : ''}`);
        if (mem.tags?.length) console.log(`   Tags: ${mem.tags.join(', ')}`);
        console.log(`   Importance: ${mem.importance || 'N/A'} | Score: ${mem.score?.toFixed(3) || 'N/A'}`);
        console.log('');
      });
    } else {
      console.error('❌ Search failed:', res.data.error?.message || 'Unknown error');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Request failed:', err.message);
    process.exit(1);
  }
}

// List memories
async function list(options) {
  const config = loadConfig();
  const { apiUrl, apiKey, agentId } = config;
  
  const limit = options.limit || 20;
  const params = new URLSearchParams({
    agentId,
    limit: limit.toString()
  });
  
  try {
    const res = await request(`${apiUrl}/v1/memories?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    if (res.data.success) {
      const memories = res.data.data.memories || [];
      console.log(`\n📚 Your ${limit} most recent memories:\n`);
      
      memories.forEach((mem, i) => {
        const date = new Date(mem.timestamp).toLocaleString();
        console.log(`${i + 1}. [${date}] ${mem.content.substring(0, 80)}${mem.content.length > 80 ? '...' : ''}`);
        if (mem.tags?.length) console.log(`   Tags: ${mem.tags.join(', ')}`);
        console.log('');
      });
      
      if (res.data.data.pagination?.has_more) {
        console.log(`... and more! (showing first ${limit})`);
      }
    } else {
      console.error('❌ List failed:', res.data.error?.message || 'Unknown error');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Request failed:', err.message);
    process.exit(1);
  }
}

// Configure
function configure(apiUrl, apiKey, agentId) {
  const config = { apiUrl, apiKey, agentId };
  saveConfig(config);
  console.log('✅ Configuration complete!');
  console.log(`   API URL: ${apiUrl}`);
  console.log(`   Agent ID: ${agentId}`);
}

// Parse arguments
const args = process.argv.slice(2);
const command = args[0];

if (!command || command === 'help') {
  console.log(`
Memory Weaver CLI - Frictionless memory storage

Usage:
  mw <content>                     Store a memory
  mw search <query>                Search memories
  mw list                          List recent memories
  mw config <url> <key> <agentId>  Configure API

Options for 'mw <content>':
  --tags <tag1,tag2>     Comma-separated tags
  --importance <0-1>     Importance (default: 0.8)
  --emotion <emotion>    Emotion tag

Options for 'mw search':
  --limit <n>            Max results (default: 10)
  --cross                Search across all agents

Options for 'mw list':
  --limit <n>            Max results (default: 20)

Examples:
  mw "Implemented room context API in 8 minutes" --tags api,triologue --importance 0.9
  mw search "dashboard" --limit 5
  mw search "ice collaboration" --cross
  mw list --limit 10
  mw config http://87.106.147.208:3100 mw_agent_lava_... lava
`);
  process.exit(0);
}

// Parse options
function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const value = args[i + 1];
      options[key] = value;
      i++;
    }
  }
  return options;
}

// Route command
(async () => {
  try {
    if (command === 'config') {
      if (args.length < 4) {
        console.error('Usage: mw config <apiUrl> <apiKey> <agentId>');
        process.exit(1);
      }
      configure(args[1], args[2], args[3]);
    } else if (command === 'search') {
      const query = args[1];
      if (!query) {
        console.error('Usage: mw search <query> [--limit n] [--cross]');
        process.exit(1);
      }
      const options = parseOptions(args.slice(2));
      await search(query, options);
    } else if (command === 'list') {
      const options = parseOptions(args.slice(1));
      await list(options);
    } else {
      // Default: store memory
      const content = args.join(' ').replace(/--\w+\s+\S+/g, '').trim();
      const options = parseOptions(args);
      
      if (!content) {
        console.error('Usage: mw <content> [--tags ...] [--importance ...]');
        process.exit(1);
      }
      
      await store(content, options);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
