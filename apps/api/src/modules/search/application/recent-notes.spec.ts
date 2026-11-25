import { RecentNotes } from './recent-notes';

describe('RecentNotes: the bounded recent-notes cache', () => {
  it('remembers keys and drops the least recently used beyond the capacity', () => {
    const notes = new RecentNotes(2);
    notes.add('a');
    notes.add('b');
    expect(notes.has('a')).toBe(true); // a is now the most recent
    notes.add('c'); // b goes
    expect(notes.has('b')).toBe(false);
    expect(notes.has('a')).toBe(true);
    expect(notes.has('c')).toBe(true);
    expect(notes.size).toBe(2);
  });
});
