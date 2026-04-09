import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { loadCurrentMd } from './current.js';

describe('loadCurrentMd()', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprint-test-'));
    tmpFile = path.join(tmpDir, 'CURRENT.md');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns nulls when file does not exist', async () => {
    const result = await loadCurrentMd('/nonexistent/CURRENT.md');
    expect(result.currentTask).toBeNull();
    expect(result.nextTodo).toBeNull();
    expect(result.raw).toBe('');
  });

  it('extracts current task from ## Current Task section', async () => {
    await fs.writeFile(tmpFile, [
      '# CURRENT.md',
      '## Current Task',
      'Implement CI Health Tab for depsight',
      '',
    ].join('\n'));

    const result = await loadCurrentMd(tmpFile);
    expect(result.currentTask).toBe('Implement CI Health Tab for depsight');
  });

  it('extracts first unchecked checkbox as nextTodo', async () => {
    await fs.writeFile(tmpFile, [
      '# CURRENT.md',
      '## Tasks',
      '- [x] Done task',
      '- [ ] Write unit tests',
      '- [ ] Another todo',
    ].join('\n'));

    const result = await loadCurrentMd(tmpFile);
    expect(result.nextTodo).toBe('Write unit tests');
  });

  it('prefers nextTodo over currentTask for focus goal', async () => {
    await fs.writeFile(tmpFile, [
      '## Current Task',
      'Big project work',
      '## Tasks',
      '- [ ] Specific next step',
    ].join('\n'));

    const result = await loadCurrentMd(tmpFile);
    expect(result.currentTask).toBe('Big project work');
    expect(result.nextTodo).toBe('Specific next step');
  });

  it('handles empty file gracefully', async () => {
    await fs.writeFile(tmpFile, '');
    const result = await loadCurrentMd(tmpFile);
    expect(result.currentTask).toBeNull();
    expect(result.nextTodo).toBeNull();
  });

  it('strips list markers from current task', async () => {
    await fs.writeFile(tmpFile, [
      '## Current Focus',
      '- Build sprint timer tool',
    ].join('\n'));

    const result = await loadCurrentMd(tmpFile);
    expect(result.currentTask).toBe('Build sprint timer tool');
  });

  it('returns raw file contents', async () => {
    const content = '## Current Task\nSome task\n';
    await fs.writeFile(tmpFile, content);
    const result = await loadCurrentMd(tmpFile);
    expect(result.raw).toBe(content);
  });
});
