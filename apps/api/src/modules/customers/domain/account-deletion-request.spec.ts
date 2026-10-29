import { parseAdminReason, parseTicketRef } from './account-deletion-request';

// Mojtaba 4 (customers package 5c): the admin's free text is trimmed, then needs at least one
// character; the database CHECK (char_length between 1 and 500) is the second line.
describe('the admin-entered text of a deletion request', () => {
  it.each(['', ' ', '   ', '\t', ' ', '   '])(
    'rejects a reason or cancel note of only whitespace (%j)',
    (text) => {
      expect(parseAdminReason(text)).toEqual({
        ok: false,
        error: { path: 'reason', code: 'range' },
      });
    },
  );

  it('trims, then accepts 1 to 500 characters', () => {
    expect(parseAdminReason('  Buyer asked by phone  ')).toEqual({
      ok: true,
      value: 'Buyer asked by phone',
    });
    expect(parseAdminReason('x'.repeat(500)).ok).toBe(true);
    expect(parseAdminReason('x'.repeat(501)).ok).toBe(false);
  });

  it('rejects a ticket reference of only whitespace', () => {
    expect(parseTicketRef('   ')).toEqual({
      ok: false,
      error: { path: 'ticketRef', code: 'range' },
    });
  });
});
