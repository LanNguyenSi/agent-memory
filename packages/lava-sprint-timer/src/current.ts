import fs from 'fs/promises';

export interface CurrentMdData {
  currentTask: string | null;
  nextTodo: string | null;
  raw: string;
}

/**
 * Parse CURRENT.md to extract current task and next open TODO
 */
export async function loadCurrentMd(filePath: string): Promise<CurrentMdData> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { currentTask: null, nextTodo: null, raw: '' };
  }

  const lines = raw.split('\n');
  let currentTask: string | null = null;
  let nextTodo: string | null = null;

  for (const line of lines) {
    // Match "## Current Task" or "## Current" section header + next non-empty line
    if (/^##?\s*(current\s*task|current\s*focus|working\s*on)/i.test(line)) {
      const nextLine = lines[lines.indexOf(line) + 1]?.trim();
      if (nextLine && !nextLine.startsWith('#')) {
        currentTask = nextLine.replace(/^[-*]\s*/, '').trim();
      }
    }

    // Match first unchecked checkbox: - [ ] ...
    if (!nextTodo && /^[-*]\s*\[ \]\s+/.test(line)) {
      nextTodo = line.replace(/^[-*]\s*\[ \]\s+/, '').trim();
    }
  }

  // Fallback: grab first H2 content after "Status" or "Now"
  if (!currentTask) {
    for (let i = 0; i < lines.length; i++) {
      if (/^##?\s*(status|now|heute|today)/i.test(lines[i])) {
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && !nextLine.startsWith('#') && nextLine.length > 5) {
          currentTask = nextLine.replace(/^[-*]\s*/, '').trim();
          break;
        }
      }
    }
  }

  return { currentTask, nextTodo, raw };
}
