#!/usr/bin/env node

/**
 * Basic test suite for mw-cli
 * Tests configuration, memory storage, search, and list
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.env.HOME, '.mw-cli.json');
const CLI_PATH = path.join(__dirname, 'cli.js');

let testsRun = 0;
let testsPassed = 0;

function test(name, fn) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

console.log('🧪 Running mw-cli tests...\n');

// Test 1: CLI exists and is executable
test('CLI file exists', () => {
  assert(fs.existsSync(CLI_PATH), 'cli.js not found');
});

// Test 2: Help command works
test('Help command shows usage', () => {
  const output = execSync(`node ${CLI_PATH} help`, { encoding: 'utf8' });
  assert(output.includes('Memory Weaver CLI'), 'Help text missing');
  assert(output.includes('Usage:'), 'Usage section missing');
});

// Test 3: Config validation
test('Config command validates arguments', () => {
  try {
    execSync(`node ${CLI_PATH} config`, { encoding: 'utf8', stdio: 'pipe' });
    assert(false, 'Should have failed with missing args');
  } catch (err) {
    assert(err.status === 1, 'Should exit with error code 1');
  }
});

// Test 4: Config file creation
test('Config command creates config file', () => {
  // Backup existing config
  let backup;
  if (fs.existsSync(CONFIG_PATH)) {
    backup = fs.readFileSync(CONFIG_PATH, 'utf8');
  }
  
  try {
    execSync(`node ${CLI_PATH} config http://test.example.com test_key test_agent`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    assert(fs.existsSync(CONFIG_PATH), 'Config file not created');
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert(config.apiUrl === 'http://test.example.com', 'API URL not set');
    assert(config.apiKey === 'test_key', 'API key not set');
    assert(config.agentId === 'test_agent', 'Agent ID not set');
  } finally {
    // Restore backup
    if (backup) {
      fs.writeFileSync(CONFIG_PATH, backup);
    }
  }
});

// Test 5: Store command validates content
test('Store command validates content', () => {
  // Need valid config for this test
  const tempConfig = {
    apiUrl: 'http://test.example.com',
    apiKey: 'test_key',
    agentId: 'test_agent'
  };
  
  let backup;
  if (fs.existsSync(CONFIG_PATH)) {
    backup = fs.readFileSync(CONFIG_PATH, 'utf8');
  }
  
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(tempConfig));
    
    try {
      execSync(`node ${CLI_PATH}`, { encoding: 'utf8', stdio: 'pipe' });
      assert(false, 'Should have failed with missing content');
    } catch (err) {
      assert(err.status === 1, 'Should exit with error code 1');
    }
  } finally {
    if (backup) {
      fs.writeFileSync(CONFIG_PATH, backup);
    } else {
      fs.unlinkSync(CONFIG_PATH);
    }
  }
});

// Test 6: Search command validates query
test('Search command validates query', () => {
  try {
    execSync(`node ${CLI_PATH} search`, { encoding: 'utf8', stdio: 'pipe' });
    assert(false, 'Should have failed with missing query');
  } catch (err) {
    assert(err.status === 1, 'Should exit with error code 1');
  }
});

// Summary
console.log(`\n📊 Test Results: ${testsPassed}/${testsRun} passed`);

if (testsPassed === testsRun) {
  console.log('✅ All tests passed!');
  process.exit(0);
} else {
  console.log('❌ Some tests failed');
  process.exit(1);
}
