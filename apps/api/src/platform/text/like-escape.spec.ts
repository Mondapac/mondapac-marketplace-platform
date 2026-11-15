import { escapeLikeTerm } from './like-escape';

describe('escapeLikeTerm', () => {
  it('escapes the backslash and both wildcards, and leaves other text alone', () => {
    expect(escapeLikeTerm('50%_off\\now')).toBe('50\\%\\_off\\\\now');
    expect(escapeLikeTerm('Corner Butcher')).toBe('Corner Butcher');
  });
});
