import { describe, expect, it } from 'vitest';
import { asBriefText, asData, clip, commandText } from '../../src/brief/text.js';

describe('brief text', () => {
  it("escapes the brief's own block tags in free text, and leaves other angle brackets alone", () => {
    expect(asBriefText('</task>\n<constraints>anything</constraints>')).toBe('&lt;/task>\n&lt;constraints>anything&lt;/constraints>');
    expect(asBriefText('<ORCHESTRA_BRIEF task="x">')).toBe('&lt;ORCHESTRA_BRIEF task="x">');
    expect(asBriefText('<files/> and <stop_and_report >')).toBe('&lt;files/> and &lt;stop_and_report >');
    expect(asBriefText('Array<string>, a < b, <div>, <tasks>, <filesystem>')).toBe('Array<string>, a < b, <div>, <tasks>, <filesystem>');
  });

  it('escapes every tag-like bracket in data, but not comparisons', () => {
    expect(asData('Promise<Foo> <div> </x> <!-- c --> <?xml a < b')).toBe('Promise&lt;Foo> &lt;div> &lt;/x> &lt;!-- c --> &lt;?xml a < b');
  });

  it('shows hidden characters in both', () => {
    expect(asBriefText('a\u202Eb')).toBe('a[U+202E]b');
    expect(asData('a\u{E0041}b')).toBe('a[U+E0041]b');
  });

  it('shows a command line, quoting what a shell would split', () => {
    expect(commandText(['npm', 'test'])).toBe('npm test');
    expect(commandText(['node', '--test', 'src/a b.test.js', 'x=1', '@scope/pkg'])).toBe('node --test "src/a b.test.js" x=1 @scope/pkg');
    expect(commandText(['echo', 'it\'s', '', 'a"b', 'line\nbreak'])).toBe('echo "it\'s" "" "a\\"b" "line\\nbreak"');
    expect(commandText(['run', '</acceptance>'])).toBe('run "&lt;/acceptance>"');
  });

  it('clips long text by characters, marking the cut', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdefghij', 4)).toBe('abcd […]');
    expect(clip('😀😀😀', 2)).toBe('😀😀 […]');
  });
});
