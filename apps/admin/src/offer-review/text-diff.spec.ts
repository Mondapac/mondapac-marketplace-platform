import { describe, expect, it } from 'vitest';
import { descriptionDiffs, diffText, tagDiff } from './text-diff.ts';

describe('diffText', () => {
  it('marks the words that left and the words that came', () => {
    const { live, proposed } = diffText('Sealed pack of dates', 'Sealed box of fresh dates');
    expect(live.filter((p) => p.kind === 'removed').map((p) => p.text)).toEqual(['pack']);
    expect(proposed.filter((p) => p.kind === 'added').map((p) => p.text)).toEqual([
      'box',
      'fresh ',
    ]);
    expect(live.map((p) => p.text).join('')).toBe('Sealed pack of dates');
    expect(proposed.map((p) => p.text).join('')).toBe('Sealed box of fresh dates');
  });
  it('has no marks for equal texts and handles an empty side', () => {
    expect(diffText('same', 'same').live).toEqual([{ kind: 'same', text: 'same' }]);
    expect(diffText('', 'new text').proposed).toEqual([{ kind: 'added', text: 'new text' }]);
    expect(diffText('old text', '').live).toEqual([{ kind: 'removed', text: 'old text' }]);
  });
  it('does not compare a very long text word by word', () => {
    const long = 'word '.repeat(2000);
    expect(diffText(long, `${long}x`).proposed).toEqual([{ kind: 'added', text: `${long}x` }]);
  });
});

describe('descriptionDiffs', () => {
  it('lists the changed locales first', () => {
    const rows = descriptionDiffs({ 'en-AU': 'a', ms: 'b' }, { 'en-AU': 'a', ms: 'c', ar: 'd' });
    expect(rows.map((r) => [r.locale, r.changed])).toEqual([
      ['ar', true],
      ['ms', true],
      ['en-AU', false],
    ]);
  });
});

describe('tagDiff', () => {
  it('splits added, kept and removed type codes', () => {
    expect(tagDiff(['halal', 'organic'], ['halal', 'kosher'])).toEqual({
      added: ['kosher'],
      kept: ['halal'],
      removed: ['organic'],
    });
  });
});
