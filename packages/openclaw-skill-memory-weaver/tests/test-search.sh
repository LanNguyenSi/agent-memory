#!/bin/bash
# Test suite for Memory Weaver Skill

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARCH_SCRIPT="$SCRIPT_DIR/../scripts/search.sh"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
PASSED=0
FAILED=0

# Helper functions
pass() {
    echo -e "${GREEN}✓${NC} $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}✗${NC} $1"
    FAILED=$((FAILED + 1))
}

info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

# --- Test 1: Script exists and is executable ---
echo "Test 1: Script accessibility"
if [[ -x "$SEARCH_SCRIPT" ]]; then
    pass "search.sh is executable"
else
    chmod +x "$SEARCH_SCRIPT" 2>/dev/null && pass "search.sh made executable" || fail "search.sh not found or not executable"
fi

# --- Test 2: Health check (via search for known term) ---
echo -e "\nTest 2: API connectivity"
set +e
OUTPUT=$("$SEARCH_SCRIPT" "test" 1 2>&1)
EXIT_CODE=$?
set -e

if [[ $EXIT_CODE -eq 0 ]]; then
    if [[ "$OUTPUT" == *"Error"* ]] && [[ "$OUTPUT" == *"401"* ]]; then
        fail "API returned 401 Unauthorized - check API key"
    elif [[ "$OUTPUT" == *"Error"* ]]; then
        fail "API connection failed: $OUTPUT"
    else
        pass "API is reachable and responding"
    fi
else
    fail "search.sh execution failed (exit code $EXIT_CODE)"
fi

# --- Test 3: Search with limit ---
echo -e "\nTest 3: Search with limit parameter"
set +e
OUTPUT=$("$SEARCH_SCRIPT" "memory" 3 2>&1)
EXIT_CODE=$?
set -e

if [[ $EXIT_CODE -eq 0 ]]; then
    if [[ "$OUTPUT" == *"Found"* ]] || [[ "$OUTPUT" == *"No results"* ]]; then
        pass "Search with limit works"
    else
        fail "Unexpected output: $OUTPUT"
    fi
else
    fail "Search with limit failed (exit code $EXIT_CODE)"
fi

# --- Test 4: Empty query handling ---
echo -e "\nTest 4: Empty query handling"
set +e
OUTPUT=$("$SEARCH_SCRIPT" "" 2>&1)
EXIT_CODE=$?
set -e

if [[ $EXIT_CODE -eq 0 ]]; then
    fail "Empty query should fail but didn't"
else
    if [[ "$OUTPUT" == *"Usage:"* ]]; then
        pass "Empty query handled correctly"
    else
        fail "Empty query failed without usage message"
    fi
fi

# --- Test 5: Response time check ---
echo -e "\nTest 5: Response time (<2s target)"
set +e
START=$(date +%s%N)
"$SEARCH_SCRIPT" "test" 5 >/dev/null 2>&1
END=$(date +%s%N)
set -e
DURATION=$(( (END - START) / 1000000 )) # ms

if [[ $DURATION -lt 2000 ]]; then
    pass "Response time: ${DURATION}ms (<2s)"
elif [[ $DURATION -lt 5000 ]]; then
    info "Response time: ${DURATION}ms (acceptable but >2s)"
    PASSED=$((PASSED + 1))
else
    fail "Response time: ${DURATION}ms (too slow)"
fi

# --- Summary ---
echo -e "\n=========================================="
echo "Tests passed: $PASSED"
echo "Tests failed: $FAILED"
echo "=========================================="

if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
