/** Canonical JSON and hashing, so approvals can be bound to exactly one normalized plan. */

import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Cannot hash a non-finite number.');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined) throw new Error('Cannot hash undefined inside an array.');
            return canonical(item);
          })
          .join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const parts = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`Cannot hash a value of type ${typeof value}.`);
  }
}

export function canonicalJson(value: unknown): string {
  return canonical(value);
}

export function sha256Of(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}
