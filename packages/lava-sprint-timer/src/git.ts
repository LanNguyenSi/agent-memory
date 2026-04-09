import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

interface CommitSessionEndOptions {
  lavaIceLogsPath: string;
  startedAt: Date;
  durationMin: number;
  focusGoal: string | null;
  message: string;
}

/**
 * Append a session-end entry to today's log file and commit it.
 */
export async function commitSessionEnd(opts: CommitSessionEndOptions): Promise<void> {
  const { lavaIceLogsPath, startedAt, durationMin, focusGoal, message } = opts;

  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(lavaIceLogsPath, `${today}-session-log.md`);

  const now = new Date();
  const endedAt = now.toISOString().slice(11, 16); // HH:MM
  const startedAtStr = startedAt.toISOString().slice(11, 16);

  const entry = [
    `## Session ${startedAtStr} → ${endedAt} (${durationMin}m)`,
    focusGoal ? `**Focus:** ${focusGoal}` : '',
    message ? `**Done:** ${message}` : '',
    '',
  ].filter(s => s !== undefined).join('\n');

  // Check if file exists, create with header if not
  let existing = '';
  try {
    existing = await fs.readFile(logFile, 'utf-8');
  } catch {
    existing = `# Session Log — ${today}\n\n`;
  }

  await fs.writeFile(logFile, existing + entry + '\n');

  // Git add + commit
  execSync(`git -C "${lavaIceLogsPath}" add "${logFile}"`, { stdio: 'pipe' });
  execSync(
    `git -C "${lavaIceLogsPath}" commit -m "🌋 session end: ${durationMin}m${focusGoal ? ` — ${focusGoal.slice(0, 60)}` : ''}"`,
    { stdio: 'pipe' }
  );

  // Try push, non-fatal
  try {
    execSync(`git -C "${lavaIceLogsPath}" push`, { stdio: 'pipe' });
  } catch {
    // Push failure is non-fatal — local commit is enough
  }
}
