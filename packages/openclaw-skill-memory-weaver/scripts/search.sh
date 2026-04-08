#!/bin/bash
# Memory Weaver Cloud - Search Script
# Usage: ./search.sh "query" [limit] [tags]

set -euo pipefail

# --- Configuration ---
CONFIG_FILE="${HOME}/.openclaw/skills/memory-weaver/config.json"
TOOLS_FILE="${HOME}/.openclaw/workspace/TOOLS.md"

# Try to load config from config.json
if [[ -f "$CONFIG_FILE" ]]; then
    API_URL=$(jq -r '.apiUrl' "$CONFIG_FILE" 2>/dev/null || echo "")
    API_KEY=$(jq -r '.apiKey' "$CONFIG_FILE" 2>/dev/null || echo "")
    DEFAULT_LIMIT=$(jq -r '.defaultLimit // 10' "$CONFIG_FILE" 2>/dev/null || echo "10")
fi

# Fallback: try to extract from TOOLS.md
if [[ -z "${API_URL:-}" ]] && [[ -f "$TOOLS_FILE" ]]; then
    API_URL=$(grep -A2 "Memory Weaver Cloud" "$TOOLS_FILE" | grep "API URL:" | cut -d: -f2- | xargs || echo "")
    API_KEY=$(grep -A3 "Memory Weaver Cloud" "$TOOLS_FILE" | grep "API Key:" | cut -d: -f2- | xargs || echo "")
fi

# Hard default (Stone's VPS)
API_URL="${API_URL:-http://85.215.150.76/v1}"
DEFAULT_LIMIT="${DEFAULT_LIMIT:-10}"

# --- Arguments ---
QUERY="${1:-}"
LIMIT="${2:-$DEFAULT_LIMIT}"
TAGS="${3:-}"

if [[ -z "$QUERY" ]]; then
    echo "Usage: $0 \"query\" [limit] [tags]" >&2
    echo "Example: $0 \"triologue\" 5 \"ice,lava\"" >&2
    exit 1
fi

if [[ -z "$API_KEY" ]]; then
    echo "Error: API_KEY not configured. Set in $CONFIG_FILE or $TOOLS_FILE" >&2
    exit 1
fi

# --- Build request URL ---
REQUEST_URL="${API_URL}/memories/search?q=$(printf '%s' "$QUERY" | jq -sRr @uri)&limit=$LIMIT"
if [[ -n "$TAGS" ]]; then
    REQUEST_URL="${REQUEST_URL}&tags=$TAGS"
fi

# --- Execute search ---
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    "$REQUEST_URL")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [[ "$HTTP_CODE" != "200" ]]; then
    echo "Error: HTTP $HTTP_CODE" >&2
    echo "$BODY" | jq -r '.error // .message // .' >&2
    exit 1
fi

# --- Format output ---
echo "$BODY" | jq -r --arg query "$QUERY" '
if .success then
    if (.data.count // 0) > 0 then
        "Found \(.data.count) result(s):\n" +
        (.data.results // .data.memories // [] | 
         map(
           "---\nID: \(.id)\nTimestamp: \(.timestamp)\nImportance: \(.importance)\nTags: \(.tags | join(", "))\n\n\(.content)\n"
         ) | join("\n"))
    else
        "No results found for query: \"\($query)\""
    end
else
    "Error: \(.error // "Unknown error")"
end
'

exit 0
