import { normaliseText, parsePackSize, wantedMeasure } from './pack-size';

describe('parsePackSize', () => {
  it.each([
    ['Basmati rice 2 kg', { kind: 'mass', amount: 2000 }],
    ['Basmati Rice 2KG bag', { kind: 'mass', amount: 2000 }],
    ['Ghee 500g', { kind: 'mass', amount: 500 }],
    ['Ghee 500 g', { kind: 'mass', amount: 500 }],
    ['Olive oil 1.5 L', { kind: 'volume', amount: 1500 }],
    ['Olive oil 1,5 litres', { kind: 'volume', amount: 1500 }],
    ['Cola 6 x 330 ml', { kind: 'volume', amount: 1980 }],
    ['Cola 330ml x 6', { kind: 'volume', amount: 1980 }],
    ['Tahini 2x400g', { kind: 'mass', amount: 800 }],
    ['برنج ایرانی ۵ کیلوگرم', { kind: 'mass', amount: 5000 }],
    ['روغن مایع ۱٫۵ لیتر', { kind: 'volume', amount: 1500 }],
    ['Rice 1,000 g', { kind: 'mass', amount: 1000 }],
    ['Cola 1,500 ml', { kind: 'volume', amount: 1500 }],
    ['Rice 1,5 kg', { kind: 'mass', amount: 1500 }],
    ['Milk 1l (best before 25 days)', { kind: 'volume', amount: 1000 }],
  ])('%s', (name, expected) => {
    expect(parsePackSize(name)).toEqual(expected);
  });

  it.each([
    'Dates, premium box',
    'Rice 1 kg or 5 kg bag',
    'Honey',
    'Pack of 3',
    '1 kg 500 kg',
    'Item 0 g',
  ])('has no size in "%s"', (name) => {
    expect(parsePackSize(name)).toBeNull();
  });

  it('does not read a size out of a longer number', () => {
    expect(parsePackSize('Model 12345678 g')).toBeNull();
  });
});

describe('wantedMeasure and normaliseText', () => {
  it('converts a wish to grams, millilitres or a count', () => {
    expect(wantedMeasure(2, 'kg')).toEqual({ kind: 'mass', amount: 2000 });
    expect(wantedMeasure(250, 'g')).toEqual({ kind: 'mass', amount: 250 });
    expect(wantedMeasure(1.5, 'l')).toEqual({ kind: 'volume', amount: 1500 });
    expect(wantedMeasure(300, 'ml')).toEqual({ kind: 'volume', amount: 300 });
    expect(wantedMeasure(3, 'each')).toEqual({ kind: 'count', amount: 3 });
    expect(wantedMeasure(3, null)).toEqual({ kind: 'count', amount: 3 });
  });

  it('puts Persian and Arabic spellings of letters and digits in one form', () => {
    expect(normaliseText('كيلو ۲ ٣')).toBe('کیلو 2 3');
    expect(normaliseText('می‌خواهم')).toBe('می خواهم');
  });
});
