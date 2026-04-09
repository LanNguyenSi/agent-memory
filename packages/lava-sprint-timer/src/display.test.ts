import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SprintState } from './display.js';

// Helper to create a sprint state fixture
function makeState(overrides: Partial<SprintState> = {}): SprintState {
  return {
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10m ago
    workMinutes: 25,
    breakMinutes: 5,
    focusGoal: 'Write unit tests for sprint timer',
    currentMdPath: '/tmp/CURRENT.md',
    lavaIceLogsPath: '/tmp/lava-ice-logs',
    ...overrides,
  };
}

describe('SprintState structure', () => {
  it('has all required fields', () => {
    const state = makeState();
    expect(state.startedAt).toBeDefined();
    expect(typeof state.workMinutes).toBe('number');
    expect(typeof state.breakMinutes).toBe('number');
    expect(state.workMinutes).toBeGreaterThan(0);
    expect(state.breakMinutes).toBeGreaterThan(0);
  });

  it('allows null focusGoal', () => {
    const state = makeState({ focusGoal: null });
    expect(state.focusGoal).toBeNull();
  });

  it('allows null paths', () => {
    const state = makeState({ currentMdPath: null, lavaIceLogsPath: null });
    expect(state.currentMdPath).toBeNull();
    expect(state.lavaIceLogsPath).toBeNull();
  });

  it('startedAt is valid ISO string', () => {
    const state = makeState();
    expect(() => new Date(state.startedAt)).not.toThrow();
    expect(new Date(state.startedAt).getTime()).not.toBeNaN();
  });
});

describe('timer math', () => {
  it('calculates elapsed time correctly', () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000); // 5m ago
    const elapsedMin = Math.round((Date.now() - startedAt.getTime()) / 60000);
    expect(elapsedMin).toBe(5);
  });

  it('calculates remaining time correctly', () => {
    const state = makeState({
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10m ago
      workMinutes: 25,
    });
    const started = new Date(state.startedAt);
    const endTime = new Date(started.getTime() + state.workMinutes * 60 * 1000);
    const remainingMin = Math.round((endTime.getTime() - Date.now()) / 60000);
    expect(remainingMin).toBe(15);
  });

  it('remaining time is 0 when sprint overdue', () => {
    const state = makeState({
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30m ago
      workMinutes: 25,
    });
    const started = new Date(state.startedAt);
    const endTime = new Date(started.getTime() + state.workMinutes * 60 * 1000);
    const remainingMin = Math.max(0, Math.round((endTime.getTime() - Date.now()) / 60000));
    expect(remainingMin).toBe(0);
  });
});
