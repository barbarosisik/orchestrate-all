/**
 * The rules manifest as text (step 11): what the orchestrator gets before planning (paths and warnings, never
 * the rule text) and what the user sees at approval: which rule files workers follow, the files they import, which
 * rule files workers won't see, and the user's personal rule files. Names and link targets from the repository are
 * quoted and cut short where they could pass for lines of their own.
 */

import type { EngineName } from '../plan/schema.js';
import { shownPath, shownText, type RuleFileEntry, type RuleFlag, type RulesManifest } from './manifest.js';

const ENGINE_LABEL: Readonly<Record<EngineName, string>> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

function warnings(flags: readonly RuleFlag[]): string[] {
  return flags.map((f) => `  ! ${f.message}`);
}

function committedLine(e: RuleFileEntry): string {
  const where = e.folder === '' ? '' : ` for ${shownPath(e.folder)}/`;
  const what = e.link !== null ? `a link to ${shownText(e.link.target)}` : e.size === null ? 'size unknown' : `${e.size} bytes`;
  return `- ${shownPath(e.path)} (${e.kind}${where}, ${what})`;
}

export function formatRulesManifest(manifest: RulesManifest): string {
  const short = manifest.baseSha.slice(0, 12);
  const committed = manifest.files.filter((e) => e.source === 'committed');
  const local = manifest.files.filter((e) => e.source !== 'committed');
  const lines: string[] = [];
  if (committed.length === 0) lines.push(`No rule files in the base commit ${short}.`);
  else {
    lines.push(`Rule files in the base commit ${short}${manifest.linksAsText ? ' (links are checked out as text files)' : ''}:`);
    for (const e of committed) lines.push(committedLine(e), ...warnings(e.flags));
  }
  if (manifest.imported.length > 0) {
    lines.push('Files these rule files import:');
    for (const i of manifest.imported) lines.push(`- ${shownPath(i.path)} (imported by ${i.importedBy.map(shownPath).join(', ')})`, ...warnings(i.flags));
  }
  if (local.length > 0) {
    lines.push("Rule files workers won't see:");
    for (const e of local) lines.push(`- ${shownPath(e.path)} (${e.source === 'ignored' ? 'ignored by git' : 'not committed'})`, ...warnings(e.flags));
  }
  if (manifest.globals.length > 0) {
    lines.push('Your personal rule files:');
    for (const g of manifest.globals) {
      const loaded = `${ENGINE_LABEL[g.engine]} workers ${g.loadedByWorkers ? 'load it' : "don't load it"}`;
      const what = g.link ? 'a link, not opened' : `${g.size ?? 0} bytes`;
      lines.push(`- ${g.path} (${loaded}, ${what})`, ...warnings(g.flags));
    }
  }
  if (manifest.problems.length > 0) lines.push('Not checked:', ...manifest.problems.map((p) => `- ${p}`));
  return lines.join('\n');
}
