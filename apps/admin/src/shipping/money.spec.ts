import { describe, expect, it } from 'vitest';
import { formatMinor, inputOf, minorOf } from './money.ts';

describe('money helpers', () => {
  it('parse exactly, per currency exponent', () => {
    expect(minorOf('9.95', 'AUD')).toBe(995);
    expect(minorOf('0', 'AUD')).toBe(0);
    expect(minorOf('10', 'AUD')).toBe(1000);
    expect(minorOf('9.955', 'AUD')).toBeNull();
    expect(minorOf('500', 'JPY')).toBe(500);
    expect(minorOf('5.0', 'JPY')).toBeNull();
    expect(inputOf('995', 'AUD')).toBe('9.95');
    expect(inputOf('5', 'AUD')).toBe('0.05');
    expect(inputOf('500', 'JPY')).toBe('500');
    expect(formatMinor('995', 'AUD', 'en-AU')).toBe('$9.95');
  });
});
