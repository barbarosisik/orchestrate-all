import { describe, expect, it } from 'vitest';
import type { RulesManifest } from '../../src/rules/manifest.js';
import { formatRulesManifest } from '../../src/rules/report.js';

const BASE = '0123456789abcdef0123456789abcdef01234567';

describe('rules manifest text', () => {
  it('says when a project has no rule files', () => {
    const m: RulesManifest = { baseSha: BASE, linksAsText: false, files: [], imported: [], globals: [], problems: [] };
    expect(formatRulesManifest(m)).toBe('No rule files in the base commit 0123456789ab.');
  });

  it('lists committed files, files workers will not see, personal files and problems, with their warnings', () => {
    const m: RulesManifest = {
      baseSha: BASE,
      linksAsText: true,
      files: [
        { kind: 'AGENTS.md', family: 'shared', folder: '', nameCase: false, path: 'AGENTS.md', source: 'committed', id: 'a'.repeat(40), size: 120, lineBreaks: 3, link: null, pointsTo: null, imports: [], importsOnly: false, flags: [] },
        {
          kind: 'CLAUDE.md',
          family: 'claude',
          folder: 'web',
          nameCase: false,
          path: 'web/CLAUDE.md',
          source: 'committed',
          id: 'b'.repeat(40),
          size: 9,
          lineBreaks: null,
          link: { target: 'AGENTS.md', resolved: 'web/AGENTS.md' },
          pointsTo: null,
          imports: [],
          importsOnly: false,
          flags: [{ code: 'link-as-text', message: 'web/CLAUDE.md is a link checked out as text.' }],
        },
        { kind: 'AGENTS.md', family: 'shared', folder: 'a\nb', nameCase: false, path: 'a\nb/AGENTS.md', source: 'committed', id: 'c'.repeat(40), size: 3, lineBreaks: null, link: null, pointsTo: null, imports: [], importsOnly: false, flags: [{ code: 'odd-name', message: 'odd' }] },
        {
          kind: 'CLAUDE.local.md',
          family: 'claude',
          folder: '',
          nameCase: false,
          path: 'CLAUDE.local.md',
          source: 'ignored',
          id: null,
          size: null,
          lineBreaks: null,
          link: null,
          pointsTo: null,
          imports: [],
          importsOnly: false,
          flags: [{ code: 'not-in-worktree', message: 'CLAUDE.local.md is ignored by git, so workers won’t see it.' }],
        },
      ],
      imported: [{ path: 'docs/style.md', id: 'd'.repeat(40), size: 50, importedBy: ['CLAUDE.md', 'web/CLAUDE.md'], imports: [], flags: [{ code: 'hidden-unicode', message: 'docs/style.md has hidden characters.' }] }],
      globals: [
        { engine: 'claude', path: '/home/u/.claude/CLAUDE.md', loadedByWorkers: false, size: 40, link: false, flags: [] },
        { engine: 'codex', path: '/home/u/.codex/AGENTS.md', loadedByWorkers: true, size: null, link: true, flags: [{ code: 'hidden-unicode', message: 'hidden' }] },
      ],
      problems: ['git status failed.'],
    };
    expect(formatRulesManifest(m)).toBe(
      [
        'Rule files in the base commit 0123456789ab (links are checked out as text files):',
        '- AGENTS.md (AGENTS.md, 120 bytes)',
        '- web/CLAUDE.md (CLAUDE.md for web/, a link to "AGENTS.md")',
        '  ! web/CLAUDE.md is a link checked out as text.',
        '- "a\\nb/AGENTS.md" (AGENTS.md for "a\\nb"/, 3 bytes)',
        '  ! odd',
        'Files these rule files import:',
        '- docs/style.md (imported by CLAUDE.md, web/CLAUDE.md)',
        '  ! docs/style.md has hidden characters.',
        "Rule files workers won't see:",
        '- CLAUDE.local.md (ignored by git)',
        '  ! CLAUDE.local.md is ignored by git, so workers won’t see it.',
        'Your personal rule files:',
        "- /home/u/.claude/CLAUDE.md (Claude Code workers don't load it, 40 bytes)",
        '- /home/u/.codex/AGENTS.md (Codex workers load it, a link, not opened)',
        '  ! hidden',
        'Not checked:',
        '- git status failed.',
      ].join('\n'),
    );
  });
});
