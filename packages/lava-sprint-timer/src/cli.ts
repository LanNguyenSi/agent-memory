#!/usr/bin/env node
/**
 * lava-sprint-timer — Session focus timer for Lava 🌋
 *
 * Usage:
 *   sprint start [--work <min>] [--break <min>]
 *   sprint end   [--message "what I did"]
 *   sprint status
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { loadCurrentMd } from './current.js';
import { commitSessionEnd } from './git.js';
import { displayBanner, displayStatus, displayTimer, displaySummary, type SprintState } from './display.js';

const STATE_FILE = path.join(os.homedir(), '.lava-sprint-state.json');
const DEFAULT_WORK_MIN = 25;
const DEFAULT_BREAK_MIN = 5;

async function readState(): Promise<SprintState | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as SprintState;
  } catch {
    return null;
  }
}

async function writeState(state: SprintState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function clearState(): Promise<void> {
  try { await fs.unlink(STATE_FILE); } catch { /* already gone */ }
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const args = argv.slice(2);
  const command = args[0] ?? 'status';
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

async function cmdStart(flags: Record<string, string | boolean>): Promise<void> {
  const existing = await readState();
  if (existing) {
    const started = new Date(existing.startedAt);
    const elapsedMin = Math.round((Date.now() - started.getTime()) / 60000);
    console.log(`\n⚠️  Sprint already running (started ${elapsedMin}m ago)`);
    console.log(`   Run: sprint end   to close the current session first\n`);
    process.exit(1);
  }

  const workMin = parseInt(String(flags['work'] ?? DEFAULT_WORK_MIN));
  const breakMin = parseInt(String(flags['break'] ?? DEFAULT_BREAK_MIN));

  // Find CURRENT.md and lava-ice-logs
  const currentMdPath = await findCurrentMd();
  const lavaIceLogsPath = await findLavaIceLogs();

  // Load CURRENT.md for focus goal
  let focusGoal: string | null = null;
  if (currentMdPath) {
    const current = await loadCurrentMd(currentMdPath);
    focusGoal = current.nextTodo ?? current.currentTask ?? null;
  }

  const state: SprintState = {
    startedAt: new Date().toISOString(),
    workMinutes: workMin,
    breakMinutes: breakMin,
    focusGoal,
    currentMdPath,
    lavaIceLogsPath,
  };

  await writeState(state);
  await displayBanner(state);
  startTimer(state);
}

async function cmdEnd(flags: Record<string, string | boolean>): Promise<void> {
  const state = await readState();
  if (!state) {
    console.log('\n❌  No active sprint. Run: sprint start\n');
    process.exit(1);
  }

  const startedAt = new Date(state.startedAt);
  const durationMin = Math.round((Date.now() - startedAt.getTime()) / 60000);
  const message = String(flags['message'] ?? '');

  displaySummary(state, durationMin, message);

  // Commit session end to lava-ice-logs
  if (state.lavaIceLogsPath) {
    try {
      await commitSessionEnd({
        lavaIceLogsPath: state.lavaIceLogsPath,
        startedAt,
        durationMin,
        focusGoal: state.focusGoal,
        message,
      });
      console.log('\n✅  Session committed to lava-ice-logs');
    } catch (err) {
      console.error('\n⚠️  Could not commit to lava-ice-logs:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('\n⚠️  lava-ice-logs not found — no git commit');
  }

  await clearState();
  console.log('\n🌋  Sprint closed. Rest well!\n');
}

async function cmdStatus(): Promise<void> {
  const state = await readState();
  await displayStatus(state);
}

function startTimer(state: SprintState): void {
  const endTime = new Date(state.startedAt).getTime() + state.workMinutes * 60 * 1000;
  const interval = setInterval(() => {
    const remaining = endTime - Date.now();
    if (remaining <= 0) {
      clearInterval(interval);
      console.log('\n\n🔔  Focus block done! Take a ' + state.breakMinutes + 'm break.');
      console.log('   Run: sprint end   when your session is finished\n');
      process.exit(0);
    }
    displayTimer(remaining, state.workMinutes * 60 * 1000);
  }, 1000);

  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    clearInterval(interval);
    console.log('\n\n⚡  Sprint interrupted. Run: sprint end   to close properly.\n');
    process.exit(0);
  });
}

async function findCurrentMd(): Promise<string | null> {
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'workspace', 'git', 'lava-sprint-timer', 'CURRENT.md'),
    path.join(os.homedir(), 'CURRENT.md'),
    '/root/.openclaw/workspace/git/lava-ice-logs/CURRENT.md',
  ];
  // Also check cwd and parent
  candidates.push(path.join(process.cwd(), 'CURRENT.md'));
  candidates.push(path.join(process.cwd(), '..', 'CURRENT.md'));

  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch { /* not found */ }
  }
  return null;
}

async function findLavaIceLogs(): Promise<string | null> {
  const candidates = [
    '/root/.openclaw/workspace/git/lava-ice-logs',
    path.join(os.homedir(), 'git', 'lava-ice-logs'),
    path.join(os.homedir(), '.openclaw', 'workspace', 'git', 'lava-ice-logs'),
  ];
  for (const p of candidates) {
    try {
      await fs.access(path.join(p, '.git'));
      return p;
    } catch { /* not found */ }
  }
  return null;
}

// Main
const { command, flags } = parseArgs(process.argv);

switch (command) {
  case 'start': await cmdStart(flags); break;
  case 'end':   await cmdEnd(flags); break;
  case 'status': await cmdStatus(); break;
  default:
    console.log(`\nUsage: sprint <start|end|status> [options]\n`);
    console.log(`  start  [--work <min>] [--break <min>]  Start a sprint (default: 25m/5m)`);
    console.log(`  end    [--message "what I did"]         End sprint + commit to lava-ice-logs`);
    console.log(`  status                                  Show current sprint state\n`);
}
