import { parseAreaNamesEdit } from './service-area-names';

const LOCALES = ['en', 'fa'];
const problems = (raw: unknown) => {
  const parsed = parseAreaNamesEdit(raw, LOCALES);
  return parsed.ok ? [] : parsed.error.fields;
};

describe('parseAreaNamesEdit', () => {
  it('accepts names, trimmed, and null to restore the configured name', () => {
    const parsed = parseAreaNamesEdit(
      { areaCode: 'greater-brisbane', names: { en: '  Greater Brisbane ', fa: null } },
      LOCALES,
    );
    expect(parsed.ok && parsed.value.areaCode).toBe('greater-brisbane');
    expect(parsed.ok && [...parsed.value.names]).toEqual([
      ['en', 'Greater Brisbane'],
      ['fa', null],
    ]);
  });

  it('refuses a body that is not a closed object', () => {
    expect(problems('x')).toEqual([{ path: '', code: 'type' }]);
    expect(problems({ areaCode: 'a', names: { en: 'A' }, extra: 1 })).toEqual([
      { path: 'extra', code: 'unknown-field' },
    ]);
    expect(problems({})).toEqual([
      { path: 'areaCode', code: 'required' },
      { path: 'names', code: 'required' },
    ]);
  });

  it('checks the area code, the language and each name without echoing a value', () => {
    expect(problems({ areaCode: 'Not A Code', names: { en: 'A' } })).toEqual([
      { path: 'areaCode', code: 'format' },
    ]);
    expect(problems({ areaCode: 'a', names: {} })).toEqual([{ path: 'names', code: 'empty' }]);
    expect(problems({ areaCode: 'a', names: { de: 'A' } })).toEqual([
      { path: 'names.de', code: 'locale' },
    ]);
    expect(problems({ areaCode: 'a', names: { en: '   ' } })).toEqual([
      { path: 'names.en', code: 'value' },
    ]);
    expect(problems({ areaCode: 'a', names: { en: 'A'.repeat(121) } })).toEqual([
      { path: 'names.en', code: 'value' },
    ]);
    expect(problems({ areaCode: 'a', names: { en: 'A\u0000B' } })).toEqual([
      { path: 'names.en', code: 'value' },
    ]);
    expect(problems({ areaCode: 'a', names: { en: 5 } })).toEqual([
      { path: 'names.en', code: 'type' },
    ]);
  });
});
