import {
  echoedFieldName,
  MAX_ECHOED_UNKNOWN_FIELDS,
  MORE_FIELDS,
  parseSignUpBody,
} from './customer-sign-up.controller';

// Hassan L2: the names of unknown fields are client text echoed in an error. At most ten are
// echoed, then one marker; each is cut to 64 code points and loses control and format
// characters and lone surrogates. Characters are built from code points so none is invisible
// in this file.

const REPLACEMENT = String.fromCodePoint(0xfffd);
const VALID = { email: 'a@example.com', password: 'correct horse battery staple' };

describe('parseSignUpBody', () => {
  it('returns the input when only email and password are present', () => {
    expect(parseSignUpBody(VALID)).toEqual(VALID);
  });

  it('echoes at most ten unknown names, sorted, then one marker', () => {
    const extra = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`f${String(index).padStart(2, '0')}`, 1]),
    );

    const problems = parseSignUpBody({ ...VALID, ...extra }) as readonly {
      path: string;
      code: string;
    }[];

    expect(problems).toHaveLength(MAX_ECHOED_UNKNOWN_FIELDS + 1);
    expect(problems.slice(0, 10).map((problem) => problem.path)).toEqual(
      Array.from({ length: 10 }, (_, index) => `f${String(index).padStart(2, '0')}`),
    );
    expect(problems[10]).toEqual({ path: MORE_FIELDS, code: 'unknown-field' });
    expect(MORE_FIELDS).toBe(String.fromCodePoint(0x2026));
  });

  it('adds no marker for exactly ten unknown names', () => {
    const extra = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`g${index}`, 1]));

    const problems = parseSignUpBody({ ...VALID, ...extra }) as readonly { path: string }[];

    expect(problems).toHaveLength(10);
    expect(problems.map((problem) => problem.path)).not.toContain(MORE_FIELDS);
  });

  it('still names missing fields after the unknown ones', () => {
    expect(parseSignUpBody({ displayName: 'Ali' })).toEqual([
      { path: 'displayName', code: 'unknown-field' },
      { path: 'email', code: 'required' },
      { path: 'password', code: 'required' },
    ]);
  });
});

describe('echoedFieldName', () => {
  it.each([
    ['a C0 control', 0x00],
    ['a C1 control', 0x85],
    ['a right-to-left override', 0x202e],
    ['a first-strong isolate', 0x2068],
    ['a zero-width space', 0x200b],
    ['a byte-order mark', 0xfeff],
    ['a lone high surrogate', 0xd800],
    ['a lone low surrogate', 0xdc00],
  ])('replaces %s with U+FFFD', (_case, unit) => {
    expect(echoedFieldName(`ab${String.fromCharCode(unit)}cd`)).toBe(`ab${REPLACEMENT}cd`);
  });

  it('keeps ordinary non-ASCII letters and a well-formed surrogate pair', () => {
    const name = `nam${String.fromCodePoint(0xe9)}${String.fromCodePoint(0x1f600)}`;

    expect(echoedFieldName(name)).toBe(name);
  });

  it('cuts to 64 code points, never inside a surrogate pair', () => {
    const emoji = String.fromCodePoint(0x1f600);

    const echoed = echoedFieldName(emoji.repeat(100));

    expect(Array.from(echoed)).toHaveLength(64);
    expect(echoed).toBe(emoji.repeat(64));
  });
});
