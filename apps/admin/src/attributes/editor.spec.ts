import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import {
  checkForm,
  contentOf,
  emptyForm,
  missingLocales,
  moved,
  problemOf,
  remapValueErrors,
  sentCodes,
  suggestCode,
  valuesFromLines,
  type EditorForm,
} from './editor.ts';

// The editor's pure parts (attributes A2, part 2), in both Market fixtures' default locales.
describe.each(['en-AU', 'ja-JP'])('attribute editor form (%s)', (locale) => {
  const form = (over: Partial<EditorForm> = {}): EditorForm => ({
    ...emptyForm(),
    names: { [locale]: ' Pack size ' },
    ...over,
  });

  it('makes the same code as the API, and none from another script', () => {
    expect(suggestCode('Pack Size')).toBe('pack-size');
    expect(suggestCode('500 g')).toBe('v-500-g');
    expect(suggestCode('Café crème')).toBe('cafe-creme');
    expect(suggestCode('パック')).toBe('');
  });

  it('sends every key, trimmed, with empty languages left out', () => {
    const values = valuesFromLines(' Red \n\nBlue', locale);
    const body = contentOf(
      form({
        names: { [locale]: ' Pack size ', 'fa-IR': '  ' },
        values: [{ ...values[0]!, code: 'red', saved: true }, values[1]!],
        internalNote: '  ',
        isVariantOption: true,
        maxLength: '40',
        min: '1',
      }),
      'select',
      locale,
    );
    expect(body).toEqual({
      names: { [locale]: 'Pack size' },
      material: false,
      isVariantOption: true,
      bounds: {},
      options: [
        { code: 'red', labels: { [locale]: 'Red' }, active: true },
        { labels: { [locale]: 'Blue' }, active: true },
      ],
      helpText: {},
      showOnProductPage: true,
      searchable: false,
      canBeFilter: false,
      internalNote: null,
      position: 0,
    });
    expect(
      contentOf(form({ isVariantOption: true, min: '2', max: '9' }), 'integer', locale),
    ).toMatchObject({ isVariantOption: false, bounds: { min: 2, max: 9 }, options: [] });
  });

  it('checks the default name, each label and the numbers before sending', () => {
    expect(checkForm(form({ names: {} }), 'text', locale)).toEqual({
      [`names.${locale}`]: 'required',
    });
    expect(
      checkForm(form({ values: valuesFromLines('A', 'xx'), position: '-1' }), 'select', locale),
    ).toEqual({ [`options[0].labels.${locale}`]: 'required', position: 'number' });
    expect(checkForm(form({ min: '1.5' }), 'integer', locale)).toEqual({
      'bounds.min': 'number',
    });
    expect(checkForm(form({ min: '1.5' }), 'decimal', locale)).toEqual({});
  });

  it('lists the languages still missing a name or an active label', () => {
    const values = valuesFromLines('A', locale);
    expect(
      missingLocales(
        form({ values: [{ ...values[0]!, labels: { [locale]: 'A', 'fa-IR': 'الف' } }] }),
        'select',
        [locale, 'fa-IR'],
      ),
    ).toEqual(['fa-IR']);
  });

  it('reads a refusal: a value named by code points at its row; stale asks to reload', () => {
    const values = ['mild', 'hot'];
    expect(
      problemOf(
        {
          status: 422,
          code: 'attribute-definition.text-invalid',
          details: { fields: [{ path: `options.hot.labels.${locale}`, code: 'invalid' }] },
        },
        values,
      ),
    ).toEqual({
      key: 'content',
      reload: false,
      fields: { [`options[1].labels.${locale}`]: 'invalid' },
    });
    expect(problemOf({ status: 409, code: 'attribute.stale' })).toEqual({
      key: 'stale',
      reload: true,
      fields: {},
    });
    expect(problemOf({ status: 409, code: 'attribute.code-taken' }).fields).toEqual({
      code: 'taken',
    });
    expect(problemOf({ status: 503, code: 'claim-text.check-unavailable' }).key).toBe(
      'check-unavailable',
    );
    expect(problemOf({ status: 0, code: 'network' }).key).toBe('unavailable');
  });

  it('moves a value up or down, and not past either end', () => {
    expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });

  it('makes value-N codes for values in another script, never one already taken', () => {
    const rows = valuesFromLines('小\n中\nRed', locale);
    const body = contentOf(
      form({ values: [{ ...rows[0]!, code: 'value-1' }, rows[1]!, rows[2]!] }),
      'select',
      locale,
    );
    expect(body.options.map((o) => o.code)).toEqual(['value-1', 'value-2', undefined]);
  });

  it('knows the code the API saves each value under, to point a refusal at its row', () => {
    const rows = valuesFromLines('Red\n小\nRed\nBlue', locale);
    const codes = sentCodes(
      [
        { ...rows[0]!, code: 'red', saved: true },
        rows[1]!,
        rows[2]!,
        { ...rows[3]!, code: 'red-2' },
      ],
      locale,
    );
    expect(codes).toEqual(['red', 'value-1', 'red-3', 'red-2']);
    expect(
      problemOf(
        {
          status: 422,
          code: 'attribute-definition.text-invalid',
          details: { fields: [{ path: `options.red-3.labels.${locale}`, code: 'invalid' }] },
        },
        codes,
      ).fields,
    ).toEqual({ [`options[2].labels.${locale}`]: 'invalid' });
  });

  it('refuses a highest value below the lowest, and a bad code on a new value', () => {
    expect(checkForm(form({ min: '9', max: '2' }), 'integer', locale)).toEqual({
      'bounds.max': 'below-min',
    });
    const [row] = valuesFromLines('A', locale);
    expect(checkForm(form({ values: [{ ...row!, code: 'Bad Code' }] }), 'select', locale)).toEqual({
      'options[0].code': 'format',
    });
  });

  it('moves value errors with their rows and drops a removed row', () => {
    const errors = { 'options[0].code': 'format', 'options[2].labels.x': 'required', names: 'x' };
    expect(remapValueErrors(errors, [2, 1])).toEqual({
      'options[0].labels.x': 'required',
      names: 'x',
    });
  });

  describe('a measure (attributes A3)', () => {
    const measure = (over: Partial<EditorForm> = {}) =>
      form({
        measureDimension: 'mass',
        measureUnits: ['g', 'kg'],
        measureDefaultUnit: 'g',
        measureDecimals: '2',
        ...over,
      });

    it('sends the unit settings with min and max as numbers, in base units', () => {
      expect(contentOf(measure({ min: '1', max: '5000' }), 'measure', locale)).toMatchObject({
        bounds: {
          min: 1,
          max: 5000,
          measure: { dimension: 'mass', units: ['g', 'kg'], defaultUnit: 'g', decimals: 2 },
        },
        options: [],
        isVariantOption: false,
      });
    });

    it('sends no unit settings for any other type', () => {
      expect(contentOf(measure(), 'decimal', locale).bounds).toEqual({});
    });

    it('needs a unit, a default among them, and 0 to 6 decimal places', () => {
      expect(checkForm(measure(), 'measure', locale)).toEqual({});
      expect(checkForm(measure({ measureUnits: [] }), 'measure', locale)).toEqual({
        'bounds.measure.units': 'required',
      });
      expect(checkForm(measure({ measureDefaultUnit: 'm' }), 'measure', locale)).toEqual({
        'bounds.measure.defaultUnit': 'required',
      });
      for (const places of ['', '7', '-1', '1.5', 'x']) {
        expect(checkForm(measure({ measureDecimals: places }), 'measure', locale)).toEqual({
          'bounds.measure.decimals': 'number',
        });
      }
    });

    it('takes a lowest and highest value that are not negative and not reversed', () => {
      expect(checkForm(measure({ min: '-1' }), 'measure', locale)).toEqual({
        'bounds.min': 'number',
      });
      expect(checkForm(measure({ min: '10', max: '1' }), 'measure', locale)).toEqual({
        'bounds.max': 'below-min',
      });
    });

    it('reads the API refusals of the unit settings', () => {
      const failure = (code: string) => ({ status: 422, code }) as never;
      expect(problemOf(failure('attribute-definition.measure-invalid')).key).toBe(
        'measure-invalid',
      );
      expect(problemOf(failure('attribute-definition.measure-locked')).key).toBe('measure-locked');
    });
  });
});

describe('relaxation refusals', () => {
  it.each([
    ['attribute-definition.not-material', 409, 'not-material', true],
    ['relaxation.already-open', 409, 'relaxation-already-open', false],
    ['relaxation.not-found', 404, 'relaxation-gone', true],
    ['relaxation.stale', 409, 'relaxation-moved', true],
    ['relaxation.closed', 409, 'relaxation-moved', true],
    ['relaxation.expired', 409, 'relaxation-expired', true],
    ['relaxation.attribute-changed', 409, 'relaxation-attribute-changed', true],
    ['relaxation.same-admin', 403, 'relaxation-same-admin', false],
    ['relaxation.not-requester', 403, 'relaxation-not-requester', false],
  ])('maps %s to its message and reload', (code, status, key, reload) => {
    expect(problemOf({ status, code })).toEqual({ key, reload, fields: {} });
    expect((messages.attributes.editor.error as Record<string, string>)[key]).toBeTruthy();
  });
});
