import { compareWithRegister, normalisedBusinessName } from './register-comparison';

// The comparison of the register's values with the draft (sellers design 7.7 "Comparison"): a
// fixed normalisation of names (case, punctuation, a legal suffix list from configuration),
// the postcode against the draft's address, the tax answer against the seller's. A mismatch is a
// flag for the reviewer only; a value that is missing on either side is "not compared".

const SUFFIXES_A = ['pty ltd', 'pty. ltd.', 'limited'];
const SUFFIXES_B = ['kk', 'co ltd'];

describe('normalisedBusinessName', () => {
  it('folds case, punctuation, spacing and the Unicode compatibility forms', () => {
    expect(normalisedBusinessName('  Ｂａｋｅｒ & Sons!  ', [])).toBe('baker sons');
    expect(normalisedBusinessName("O'Brien's   Halls", [])).toBe('obriens halls');
  });

  it('strips one trailing legal suffix of the Market list, after the same normalisation', () => {
    expect(normalisedBusinessName('Baker Pty. Ltd.', SUFFIXES_A)).toBe('baker');
    expect(normalisedBusinessName('BAKER PTY LTD', SUFFIXES_A)).toBe('baker');
    expect(normalisedBusinessName('Baker Limited', SUFFIXES_A)).toBe('baker');
    expect(normalisedBusinessName('Baker Limited Pty Ltd', SUFFIXES_A)).toBe('baker limited');
  });

  it('does not strip a suffix that is not on the Market list, or one inside a word', () => {
    expect(normalisedBusinessName('Baker KK', SUFFIXES_A)).toBe('baker kk');
    expect(normalisedBusinessName('Bakerlimited', SUFFIXES_A)).toBe('bakerlimited');
    expect(normalisedBusinessName('Baker KK', SUFFIXES_B)).toBe('baker');
  });

  it('keeps a name that is only a suffix whole', () => {
    expect(normalisedBusinessName('Limited', SUFFIXES_A)).toBe('limited');
  });
});

describe('compareWithRegister', () => {
  const register = {
    businessName: 'Baker Pty Ltd',
    registeredForIndirectTax: true,
    postcode: '4000',
  };
  const draft = {
    businessName: 'BAKER PTY. LTD.',
    registeredForIndirectTax: true,
    postcode: '4000',
  };

  it('flags nothing when every compared value matches', () => {
    expect(compareWithRegister(register, draft, SUFFIXES_A)).toEqual([]);
  });

  it('flags the business name, the tax registration and the postcode separately', () => {
    expect(
      compareWithRegister(register, { ...draft, businessName: 'Cook Pty Ltd' }, SUFFIXES_A),
    ).toEqual(['business-name']);
    expect(
      compareWithRegister(register, { ...draft, registeredForIndirectTax: false }, SUFFIXES_A),
    ).toEqual(['indirect-tax-registration']);
    expect(compareWithRegister(register, { ...draft, postcode: '4001' }, SUFFIXES_A)).toEqual([
      'postcode',
    ]);
    expect(
      compareWithRegister(
        register,
        { businessName: 'x', registeredForIndirectTax: false, postcode: '1' },
        SUFFIXES_A,
      ),
    ).toEqual(['business-name', 'indirect-tax-registration', 'postcode']);
  });

  it('compares postcodes without spacing or case', () => {
    expect(
      compareWithRegister(
        { ...register, postcode: 'ab1 2cd' },
        { ...draft, postcode: 'AB12CD' },
        SUFFIXES_A,
      ),
    ).toEqual([]);
  });

  it('does not compare a value that is missing on either side', () => {
    expect(
      compareWithRegister(
        { businessName: null, registeredForIndirectTax: null, postcode: null },
        draft,
        SUFFIXES_A,
      ),
    ).toEqual([]);
    expect(
      compareWithRegister(
        register,
        { businessName: null, registeredForIndirectTax: null, postcode: null },
        SUFFIXES_A,
      ),
    ).toEqual([]);
  });

  it('treats a name that normalises to nothing as not compared', () => {
    expect(compareWithRegister(register, { ...draft, businessName: '...' }, SUFFIXES_A)).toEqual(
      [],
    );
  });
});
