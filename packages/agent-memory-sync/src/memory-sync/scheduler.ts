const { CliError } = require("../errors");

interface ScheduleTick {
  runAt: string;
  waitMs: number;
}

function validateCronExpression(expression: string): void {
  parseCron(expression);
}

function nextScheduleTick(expression: string, after = new Date()): ScheduleTick {
  const cron = parseCron(expression);
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let attempts = 0; attempts < 525600; attempts += 1) {
    if (
      cron.minute.has(cursor.getMinutes()) &&
      cron.hour.has(cursor.getHours()) &&
      cron.dayOfMonth.has(cursor.getDate()) &&
      cron.month.has(cursor.getMonth() + 1) &&
      cron.dayOfWeek.has(cursor.getDay())
    ) {
      return {
        runAt: cursor.toISOString(),
        waitMs: Math.max(0, cursor.getTime() - after.getTime())
      };
    }

    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new CliError(`could not compute next run for cron expression '${expression}'.`, 2);
}

function parseCron(expression: string): Record<string, Set<number>> {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CliError(
      `cron expression '${expression}' is invalid. Use the 5-field format 'minute hour day month weekday'.`,
      2
    );
  }

  return {
    minute: parsePart(parts[0], 0, 59),
    hour: parsePart(parts[1], 0, 23),
    dayOfMonth: parsePart(parts[2], 1, 31),
    month: parsePart(parts[3], 1, 12),
    dayOfWeek: parsePart(parts[4], 0, 6)
  };
}

function parsePart(value: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  for (const segment of value.split(",")) {
    if (segment === "*") {
      fillRange(result, min, max, 1);
      continue;
    }

    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(segment);
    if (stepMatch) {
      const [, rangeToken, stepToken] = stepMatch;
      const step = parseInteger(stepToken, min, max);
      if (rangeToken === "*") {
        fillRange(result, min, max, step);
      } else {
        const [start, end] = parseRange(rangeToken, min, max);
        fillRange(result, start, end, step);
      }
      continue;
    }

    if (segment.includes("-")) {
      const [start, end] = parseRange(segment, min, max);
      fillRange(result, start, end, 1);
      continue;
    }

    result.add(parseInteger(segment, min, max));
  }

  if (result.size === 0) {
    throw new CliError(`cron field '${value}' is invalid.`, 2);
  }

  return result;
}

function parseRange(value: string, min: number, max: number): [number, number] {
  const [startToken, endToken] = value.split("-");
  const start = parseInteger(startToken, min, max);
  const end = parseInteger(endToken, min, max);
  if (start > end) {
    throw new CliError(`cron range '${value}' is invalid.`, 2);
  }
  return [start, end];
}

function parseInteger(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(`cron value '${value}' is outside the allowed range ${min}-${max}.`, 2);
  }
  return parsed;
}

function fillRange(target: Set<number>, start: number, end: number, step: number): void {
  for (let cursor = start; cursor <= end; cursor += step) {
    target.add(cursor);
  }
}

module.exports = {
  validateCronExpression,
  nextScheduleTick
};
