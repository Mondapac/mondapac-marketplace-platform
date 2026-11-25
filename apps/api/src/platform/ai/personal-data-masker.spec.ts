import { MASKED, maskPersonalData, maskRequest } from './personal-data-masker';

describe('maskPersonalData (platform-ai.md section 9)', () => {
  it.each([
    ['an email', 'mail me at sara.k@example.com.au please', `mail me at ${MASKED} please`],
    ['an international phone', 'call +61 412 345 678 today', `call ${MASKED} today`],
    ['a grouped phone', 'ring 0412 345 678', `ring ${MASKED}`],
    ['a dashed phone', 'mobile 0412-345-678', `mobile ${MASKED}`],
    ['a phone in Persian digits', 'تلفن ۰۴۱۲ ۳۴۵ ۶۷۸', `تلفن ${MASKED}`],
    ['a bracketed phone', 'office (07) 3123 4567', `office ${MASKED}`],
    ['a card number', 'card 4111 1111 1111 1111 exp', `card ${MASKED} exp`],
    ['a bare card number', 'card 4111111111111111', `card ${MASKED}`],
    ['a card in other digits', 'card ۴۱۱۱۱۱۱۱۱۱۱۱۱۱۱۱', `card ${MASKED}`],
  ])('masks %s', (_name, text, expected) => {
    expect(maskPersonalData(text)).toBe(expected);
  });

  it.each([
    ['a date', 'ordered on 2026-11-25'],
    ['a date-time', 'at 2026-11-25T08:17:33Z'],
    ['a UUID', 'seller 01938a2b-4123-8456-9abc-0123456789ab'],
    ['an all-digit UUID part', 'id 20261125-0000-4000-8000-000000000001'],
    ['a tracking code', 'tracking AB123456789AU'],
    ['a bare reference number', 'order 1234567890'],
    ['a price and a quantity', '2 x 12.50 = 25.00, 5 kg'],
    ['a barcode failing Luhn', 'gtin 9300633603314'],
    ['shoe sizes', 'Sizes 36 38 40 42'],
    ['a size range', 'EU 36-37-38-39'],
    ['a dotted date', 'made 25.11.2026'],
    ['a dashed day-first date', 'made 25-11-2026'],
    ['a date and a time', 'at 2026-11-25 14:30'],
    ['a price in toman', '12 500 000 تومان'],
    ['a dotted price in rial', '125.000.000 ریال'],
    ['model numbers', 'Model 2024 1080 1920'],
  ])('keeps %s', (_name, text) => {
    expect(maskPersonalData(text)).toBe(text);
  });

  it('masks a barcode that happens to pass Luhn (accepted false positive, fails safe)', () => {
    expect(maskPersonalData('gtin 9300633603373')).toBe(`gtin ${MASKED}`);
  });

  it('keeps ids and timestamps in tool-result JSON', () => {
    const json =
      '{"id":"01938a2b-4123-7456-8abc-0123456789ab","at":"2026-11-25T08:17:33.120Z","qty":12}';
    expect(maskPersonalData(json)).toBe(json);
  });

  it('masks every message part but the system text', () => {
    const masked = maskRequest({
      system: 'Fixed rules; support +61 7 3000 0000.',
      messages: [
        { role: 'user', blocks: [{ type: 'text', text: 'I am a@b.co' }] },
        {
          role: 'assistant',
          blocks: [{ type: 'tool-call', id: 't1', name: 'find', input: { q: 'a@b.co' } }],
        },
        {
          role: 'user',
          blocks: [
            {
              type: 'tool-result',
              callId: 't1',
              content: '{"phone":"+61 412 345 678"}',
              isError: false,
            },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 100,
    });
    expect(masked.system).toBe('Fixed rules; support +61 7 3000 0000.');
    expect(masked.messages[0]!.blocks[0]).toEqual({ type: 'text', text: `I am ${MASKED}` });
    expect(masked.messages[1]!.blocks[0]).toMatchObject({ input: { q: MASKED } });
    expect(masked.messages[2]!.blocks[0]).toMatchObject({ content: `{"phone":"${MASKED}"}` });
  });
});
