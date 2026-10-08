import { canonicalJson } from './canonical-json';

// Every non-ASCII character in this file is written as an escape, so the source stays ASCII.

const canonical = (value: unknown): string => {
  const result = canonicalJson(value);
  if (!result.ok) throw new Error(`refused: ${result.error.problem}`);
  return result.value;
};

const refusalOf = (value: unknown) => {
  const result = canonicalJson(value);
  return result.ok ? 'accepted' : result.error.problem;
};

/** A double from its IEEE 754 bit pattern, as RFC 8785 Appendix B lists them. */
const fromBits = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

describe('canonicalJson (RFC 8785; platform-audit.md 6.3)', () => {
  it('canonicalises the example of RFC 8785 section 3.2.2', () => {
    // {"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
    //  "string": "€$\u000F\u000aA'B"\\\\"\/", "literals": [null, true, false]}
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as unknown;

    expect(canonical(input)).toBe(
      '{"literals":[null,true,false],' +
        '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code unit, astral characters before U+FB33 (RFC 8785 3.2.3)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };

    expect(canonical(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",' +
        '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",' +
        '"😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('orders by code unit, not by code point: U+1F600 sorts before U+E000 and after U+D7FF', () => {
    const astral = '😀';
    expect(canonical({ '': 1, [astral]: 2, '퟿': 3 })).toBe(`{"퟿":3,"${astral}":2,"":1}`);
  });

  it('writes non-ASCII text as itself and escapes only what JSON.stringify escapes', () => {
    expect(canonical('café 中 😀')).toBe('"café 中 😀"');
    expect(canonical('\u0000\u001f\u007f ')).toBe('"\\u0000\\u001f\u007f "');
  });

  it.each([
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ])('writes the number with bits %s as %s (RFC 8785 Appendix B)', (bits, expected) => {
    expect(canonical(fromBits(bits))).toBe(expected);
  });

  it('writes -0 as 0, also inside structures', () => {
    expect(canonical(-0)).toBe('0');
    expect(canonical({ a: [-0, 0] })).toBe('{"a":[0,0]}');
  });

  it('writes nested structures without whitespace, keys sorted at every level', () => {
    expect(canonical({ b: [true, null, { z: 1, a: 'x' }], a: {} })).toBe(
      '{"a":{},"b":[true,null,{"a":"x","z":1}]}',
    );
    expect(canonical([])).toBe('[]');
    expect(canonical(Object.assign(Object.create(null) as object, { k: 1 }))).toBe('{"k":1}');
  });

  it('accepts a value shared by two branches: that is not a cycle', () => {
    const shared = { id: 1 };
    expect(canonical({ a: shared, b: [shared, shared] })).toBe(
      '{"a":{"id":1},"b":[{"id":1},{"id":1}]}',
    );
  });

  describe('refusals (Hassan I1)', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    // Index 1 is a hole.
    const sparse: unknown[] = [1];
    sparse[2] = 3;

    it.each([
      ['NaN', Number.NaN, 'non-finite-number'],
      ['Infinity', Number.POSITIVE_INFINITY, 'non-finite-number'],
      ['-Infinity in an array', [Number.NEGATIVE_INFINITY], 'non-finite-number'],
      ['undefined', undefined, 'undefined'],
      ['an undefined property', { a: undefined }, 'undefined'],
      ['an array hole', sparse, 'undefined'],
      ['a BigInt', 1n, 'bigint'],
      ['a BigInt property', { n: 2n }, 'bigint'],
      ['a Date', new Date(0), 'unsupported-type'],
      ['a Map', new Map([['a', 1]]), 'unsupported-type'],
      ['a Set', new Set([1]), 'unsupported-type'],
      ['a class instance', new Point(1), 'unsupported-type'],
      ['an object with toJSON', { toJSON: () => 'x' }, 'unsupported-type'],
      ['an object with a toJSON value', { toJSON: 'x' }, 'unsupported-type'],
      ['a boxed string', Object('x') as unknown, 'unsupported-type'],
      ['a function', () => 1, 'unsupported-type'],
      ['a symbol', Symbol('s'), 'unsupported-type'],
      ['a symbol key', { [Symbol('s')]: 1 }, 'unsupported-type'],
      ['a cycle through an object', cyclic, 'cycle'],
      ['a cycle through an array', cyclicArray, 'cycle'],
      ['a lone high surrogate', 'a\ud800b', 'lone-surrogate'],
      ['a lone low surrogate', '\udc00', 'lone-surrogate'],
      ['reversed surrogates', '\ude00\ud83d', 'lone-surrogate'],
      ['a lone surrogate in a key', { '\ud800': 1 }, 'lone-surrogate'],
    ])('refuses %s', (_case, value, problem) => {
      expect(refusalOf(value)).toBe(problem);
    });

    it('refuses an accessor property without calling it', () => {
      const get = jest.fn(() => 1);
      const value = Object.defineProperty({}, 'a', { get, enumerable: true });

      expect(refusalOf(value)).toBe('unsupported-type');
      expect(get).not.toHaveBeenCalled();
    });

    it('carries a code and the problem only, never the value', () => {
      expect(canonicalJson({ secret: 'a\ud800' })).toEqual({
        ok: false,
        error: { code: 'canonical-json.refused', problem: 'lone-surrogate' },
      });
    });
  });
});
