export interface SprintState {
  startedAt: string;
  workMinutes: number;
  breakMinutes: number;
  focusGoal: string | null;
  currentMdPath: string | null;
  lavaIceLogsPath: string | null;
}

// Simple ANSI colors without external dep (chalk ESM can be tricky in bin scripts)
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function bar(filled: number, total: number, width = 30): string {
  const filledCount = Math.round((filled / total) * width);
  const emptyCount = width - filledCount;
  return c.magenta + '█'.repeat(filledCount) + c.dim + '░'.repeat(emptyCount) + c.reset;
}

export async function displayBanner(state: SprintState): Promise<void> {
  console.clear();
  console.log(`\n${c.magenta}${c.bold}🌋 LAVA SPRINT TIMER${c.reset}`);
  console.log(`${c.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
  console.log(`${c.cyan}Work block:${c.reset}  ${state.workMinutes}m`);
  console.log(`${c.cyan}Break:${c.reset}       ${state.breakMinutes}m`);

  if (state.focusGoal) {
    console.log(`\n${c.yellow}${c.bold}Focus:${c.reset} ${state.focusGoal}`);
  } else {
    console.log(`\n${c.dim}No CURRENT.md found — running without focus goal${c.reset}`);
  }

  if (state.lavaIceLogsPath) {
    console.log(`${c.dim}Session will commit to lava-ice-logs on end${c.reset}`);
  }

  console.log(`\n${c.dim}Press Ctrl+C to pause without committing${c.reset}`);
  console.log(`${c.dim}Run: sprint end   to close and commit${c.reset}\n`);
  console.log(`${c.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
}

export function displayTimer(remainingMs: number, totalMs: number): void {
  const remainingSec = Math.ceil(remainingMs / 1000);
  const min = Math.floor(remainingSec / 60);
  const sec = remainingSec % 60;
  const elapsed = totalMs - remainingMs;

  const timeStr = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  const progress = bar(elapsed, totalMs);

  process.stdout.write(`\r  ${progress}  ${c.bold}${timeStr}${c.reset} remaining  `);
}

export async function displayStatus(state: SprintState | null): Promise<void> {
  if (!state) {
    console.log(`\n${c.dim}No active sprint.${c.reset}  Run: ${c.cyan}sprint start${c.reset}\n`);
    return;
  }

  const started = new Date(state.startedAt);
  const elapsedMin = Math.round((Date.now() - started.getTime()) / 60000);
  const endTime = new Date(started.getTime() + state.workMinutes * 60 * 1000);
  const remainingMin = Math.max(0, Math.round((endTime.getTime() - Date.now()) / 60000));

  console.log(`\n${c.magenta}${c.bold}🌋 Sprint active${c.reset}`);
  console.log(`${c.cyan}Started:${c.reset}   ${started.toLocaleTimeString()}`);
  console.log(`${c.cyan}Elapsed:${c.reset}   ${elapsedMin}m`);
  console.log(`${c.cyan}Remaining:${c.reset} ${remainingMin}m of ${state.workMinutes}m block`);

  if (state.focusGoal) {
    console.log(`${c.yellow}Focus:${c.reset}     ${state.focusGoal}`);
  }

  console.log(`\n${c.dim}Run: sprint end [--message "what I did"]   to close${c.reset}\n`);
}

export function displaySummary(state: SprintState, durationMin: number, message: string): void {
  console.log(`\n${c.magenta}${c.bold}🌋 Sprint complete!${c.reset}`);
  console.log(`${c.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.cyan}Duration:${c.reset} ${durationMin}m`);

  if (state.focusGoal) {
    console.log(`${c.cyan}Focus was:${c.reset} ${state.focusGoal}`);
  }

  if (message) {
    console.log(`${c.green}Done:${c.reset}     ${message}`);
  }
}


