/**
 * Engine versions (step 10). Each CLI prints its version differently ("2.1.97 (Claude Code)", "codex-cli
 * 0.170.0"), so the first `major.minor.patch` in the text is taken, with an optional pre-release part
 * ("0.169.0-alpha.11.1"). Versions decide which features a worker may use: research §5.1 lists what changed in
 * Claude Code since the owner's 2.1.97.
 */

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The pre-release part ("alpha.11.1"), or null for a release. */
  readonly pre: string | null;
  /** The version as written: "2.1.97". */
  readonly text: string;
}

const VERSION = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** The first version in `output`, or null if it holds none. */
export function parseVersion(output: string): Version | null {
  const match = VERSION.exec(output);
  if (match === null) return null;
  const [text, major, minor, patch, pre] = match as unknown as [string, string, string, string, string | undefined];
  const numbers = [major, minor, patch].map(Number);
  if (!numbers.every(Number.isSafeInteger)) return null;
  const [a, b, c] = numbers as [number, number, number];
  return { major: a, minor: b, patch: c, pre: pre ?? null, text };
}

/** Semver's order of pre-release parts: number parts by value and before words, then the longer list after. */
function comparePre(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) {
      // Compared as digit strings, so even numbers too large for a float keep their order.
      const order = x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
      if (order !== 0) return order;
    } else if (xNumber !== yNumber) {
      return xNumber ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. A pre-release comes before its release. */
export function compareVersions(a: Version, b: Version): number {
  const order = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (order !== 0) return order;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return comparePre(a.pre, b.pre);
}

/** Whether `version` is `minimum` or newer. `minimum` is written by Orchestra, so a bad one is a bug. */
export function atLeast(version: Version, minimum: string): boolean {
  const floor = parseVersion(minimum);
  if (floor === null) throw new Error(`"${minimum}" is not a version.`);
  return compareVersions(version, floor) >= 0;
}
