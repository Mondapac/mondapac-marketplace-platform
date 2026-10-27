import { describe, expect, it } from 'vitest';
import { decimalsOf, exampleAmount, formatMinor, isMore, parseAmount, sumMinor } from './money.ts';

describe('money: decimals by currency, never a fixed 100', () => {
  it('knows the minor-unit digits of AUD, JPY and KWD', () => {
    expect(decimalsOf('AUD')).toBe(2);
    expect(decimalsOf('JPY')).toBe(0);
    expect(decimalsOf('KWD')).toBe(3);
  });

  it('formats AUD and JPY from minor units', () => {
    expect(formatMinor('2550', 'AUD', 'en-AU')).toBe('$25.50');
    expect(formatMinor('2550', 'JPY', 'en-AU')).toMatch(/2,550/);
    expect(formatMinor('2550', 'JPY', 'en-AU')).not.toMatch(/25\.5/);
    expect(formatMinor('5', 'AUD', 'en-AU')).toBe('$0.05');
  });

  it('shows a bad amount or currency as a dash', () => {
    expect(formatMinor('12.5', 'AUD', 'en-AU')).toBe('-');
    expect(formatMinor('100', 'NOPE', 'en-AU')).toBe('-');
  });

  it('keeps amounts beyond the safe float range exact', () => {
    expect(formatMinor('123456789012345678', 'AUD', 'en-AU')).toBe('$1,234,567,890,123,456.78');
  });

  it('parses typed amounts by the currency decimals', () => {
    expect(parseAmount('25', 'AUD')).toEqual({ ok: true, minor: '2500' });
    expect(parseAmount('25.5', 'AUD')).toEqual({ ok: true, minor: '2550' });
    expect(parseAmount(' 25.05 ', 'AUD')).toEqual({ ok: true, minor: '2505' });
    expect(parseAmount('2500', 'JPY')).toEqual({ ok: true, minor: '2500' });
    expect(parseAmount('1.234', 'KWD')).toEqual({ ok: true, minor: '1234' });
  });

  it('refuses too many decimals, words, and a decimal point for yen', () => {
    expect(parseAmount('25.123', 'AUD')).toEqual({ ok: false, problem: 'format' });
    expect(parseAmount('25.5', 'JPY')).toEqual({ ok: false, problem: 'format' });
    expect(parseAmount('abc', 'AUD')).toEqual({ ok: false, problem: 'format' });
    expect(parseAmount('1e3', 'AUD')).toEqual({ ok: false, problem: 'format' });
  });

  it('separates empty, zero and negative', () => {
    expect(parseAmount('  ', 'AUD')).toEqual({ ok: false, problem: 'required' });
    expect(parseAmount('0', 'AUD')).toEqual({ ok: false, problem: 'zero' });
    expect(parseAmount('0.00', 'AUD')).toEqual({ ok: false, problem: 'zero' });
    expect(parseAmount('-5', 'AUD')).toEqual({ ok: false, problem: 'zero' });
  });

  it('gives an example in the currency format', () => {
    expect(exampleAmount('AUD')).toBe('25.00');
    expect(exampleAmount('JPY')).toBe('25');
  });

  it('compares and adds minor-unit strings exactly', () => {
    expect(isMore('10001', '10000')).toBe(true);
    expect(isMore('10000', '10000')).toBe(false);
    expect(sumMinor('9007199254740993', '1')).toBe('9007199254740994');
  });
});
