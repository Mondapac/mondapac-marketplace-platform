import { Temporal } from '@mondapac/shared-kernel';
import { readOwnSuggestionList } from './own-suggestion-list-input';

// The query both seller suggestion lists (values and tags) read, so the created range is checked
// once here: `createdFrom` inclusive, `createdTo` exclusive, ISO 8601 instants with an offset.

const idOf = (value: unknown) => (typeof value === 'string' ? value : null);

describe('the query of a seller suggestion list: created range', () => {
  it('reads the range as instants, empty values as none, and keeps it off the page keys', () => {
    const read = readOwnSuggestionList(
      { createdFrom: '2026-11-01T00:00:00+10:00', createdTo: '2026-11-08T00:00:00Z', page: 2 },
      idOf,
    );
    expect(
      read.ok && read.value.created.from?.equals(Temporal.Instant.from('2026-10-31T14:00:00Z')),
    ).toBe(true);
    expect(
      read.ok && read.value.created.to?.equals(Temporal.Instant.from('2026-11-08T00:00:00Z')),
    ).toBe(true);
    expect(read.ok && read.value.read.mode).toBe('page');
    const none = readOwnSuggestionList({ createdFrom: '', createdTo: null }, idOf);
    expect(none.ok && none.value.created).toEqual({ from: null, to: null });
  });

  it.each([
    [{ createdFrom: '2026-11-01' }, 'createdFrom', 'format'],
    [{ createdTo: 'soon' }, 'createdTo', 'format'],
    [
      { createdFrom: '2026-11-02T00:00:00Z', createdTo: '2026-11-01T00:00:00Z' },
      'createdTo',
      'range',
    ],
    [{ limit: 5, createdTo: '2026-11-08T00:00:00Z' }, 'createdTo', 'conflict'],
    [{ afterId: 'a', createdFrom: '2026-11-08T00:00:00Z' }, 'createdFrom', 'conflict'],
  ])('refuses %j', (input, path, code) => {
    const read = readOwnSuggestionList(input, idOf);
    expect(!read.ok && read.error.fields).toEqual([{ path, code }]);
  });
});
