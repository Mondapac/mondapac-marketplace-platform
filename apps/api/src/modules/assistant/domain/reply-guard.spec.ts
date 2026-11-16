import {
  EVALUATION_SET,
  EVALUATION_VERSION,
  INVALID_PLAN_CALLS,
  LIST_PARSING_CASES,
} from './evaluation-set';
import { maskPersonalData, MASKED } from './personal-data';
import { guardReply, MAX_REPLY_CHARACTERS } from './reply-guard';
import { parseToolCall, TOOL_DECLARATIONS } from './tools';

// The deterministic checks around a model (plan section 5; ADR-0019 R1, R5, R9): what a buyer
// typed is masked before it is kept or sent; what a model wrote is checked before a buyer sees it.

describe('guardReply', () => {
  it('keeps plain sentences in order, and "$12.50" is one sentence, not two', () => {
    expect(guardReply('Try the dates. They suit a gift!\nAnything else?')).toEqual({
      sentences: ['Try the dates.', 'They suit a gift!', 'Anything else?'],
      notices: [],
    });
  });

  it.each([
    'These are $12.50 each.',
    'Only AUD 9 today.',
    'It costs 1200 JPY.',
    'قیمت آن ۵۰ دلار است.',
    'They are in stock now.',
    'Only 3 left!',
    'Delivery is free in Brisbane.',
    'The minimum order is two boxes.',
    'این کالا موجود است.',
  ])('drops a price, stock or delivery claim and sends the buyer to the cards: %s', (text) => {
    expect(guardReply(`Here you go. ${text}`)).toEqual({
      sentences: ['Here you go.'],
      notices: ['see-cards'],
    });
  });

  it.each([
    'This chicken is halal.',
    'It is HALAL certified.',
    'The seller holds a certificate.',
    'Kosher and vegan options exist.',
    'این گوشت حلال است.',
  ])('drops any certification claim (R1): %s', (text) => {
    expect(guardReply(text)).toEqual({ sentences: [], notices: ['see-certification'] });
  });

  it('renders the rest inert (R9): no markup, link, image, address or invisible character', () => {
    const guarded = guardReply(
      'See ![x](https://evil.example/a.png) **bold** <script>alert(1)</script> ' +
        '[the shop](https://evil.example) www.evil.example mail me@evil.example now​‮.',
    );
    expect(guarded.notices).toEqual([]);
    expect(guarded.sentences).toHaveLength(1);
    const [sentence] = guarded.sentences as [string];
    for (const piece of ['<', '>', '*', '](', 'http', 'www', '@', '​', '‮']) {
      expect(sentence).not.toContain(piece);
    }
    expect(sentence).toContain('the shop');
  });

  it('keeps the Persian zero-width non-joiner', () => {
    expect(guardReply('می‌توانم کمک کنم.').sentences).toEqual(['می‌توانم کمک کنم.']);
  });

  it('cuts a long reply at a sentence', () => {
    const sentence = `${'word '.repeat(59)}end.`;
    const guarded = guardReply(Array.from({ length: 10 }, () => sentence).join(' '));
    const length = guarded.sentences.join(' ').length;
    expect(length).toBeLessThanOrEqual(MAX_REPLY_CHARACTERS);
    expect(guarded.sentences.length).toBeGreaterThan(0);
  });
});

describe('maskPersonalData', () => {
  it('masks email addresses and runs of 8 or more digits in any grouping or script', () => {
    expect(maskPersonalData('mail a.b+c@example.com.au please')).toBe(`mail ${MASKED} please`);
    expect(maskPersonalData('call +61 (0)412 345-678')).toBe(`call ${MASKED}`);
    expect(maskPersonalData('card 4111 1111 1111 1111')).toBe(`card ${MASKED}`);
    expect(maskPersonalData('شماره ۰۹۱۲۳۴۵۶۷۸۹')).toBe(`شماره ${MASKED}`);
  });

  it('keeps short numbers: quantities, sizes and postcodes', () => {
    expect(maskPersonalData('2 boxes of 500 g to 4000')).toBe('2 boxes of 500 g to 4000');
  });
});

describe('parseToolCall (R9: model output is schema-validated)', () => {
  const CATEGORY = '0199aaaa-0000-7000-8000-000000000001';

  it('declares only READ tools and the two "not ready" actions', () => {
    expect(TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
      'search_products',
      'list_bestsellers',
      'list_specials',
      'get_product',
      'get_seller',
      'list_categories',
      'show_page',
      'support_contact',
      'suggest_cart_change',
      'open_support_form',
      'plan_basket',
    ]);
  });

  it('accepts well-formed calls', () => {
    expect(parseToolCall('search_products', { text: ' dates ', category_id: CATEGORY })).toEqual({
      tool: 'search_products',
      text: 'dates',
      categoryId: CATEGORY,
    });
    expect(parseToolCall('show_page', { page: 'category', category_id: CATEGORY })).toEqual({
      tool: 'show_page',
      page: 'category',
      categoryId: CATEGORY,
    });
    expect(parseToolCall('list_specials', {})).toEqual({ tool: 'list_specials', categoryId: null });
    expect(parseToolCall('get_product', { product_id: CATEGORY })).toEqual({
      tool: 'get_product',
      productId: CATEGORY,
    });
    expect(parseToolCall('get_seller', { seller_id: CATEGORY })).toEqual({
      tool: 'get_seller',
      sellerId: CATEGORY,
    });
  });

  it.each([
    ['get_account', {}],
    ['search_products', { text: 'x' }],
    ['search_products', { text: 'dates', category_id: '../../admin' }],
    ['show_page', { page: 'https://evil.example' }],
    ['show_page', { page: 'category' }],
    ['show_page', { page: 'cart', category_id: CATEGORY }],
    ['list_bestsellers', { category_id: 7 }],
    ['get_product', {}],
    ['get_product', { product_id: '../../admin' }],
    ['get_product', { product_id: 7 }],
    ['get_seller', { seller_id: 'seller-1' }],
    ['get_seller', { product_id: CATEGORY }],
  ])('refuses %s with %j', (name, input) => {
    expect(parseToolCall(name, input)).toBeNull();
  });

  it('never takes an account, seller or Market from the model', () => {
    expect(
      parseToolCall('search_products', {
        text: 'dates',
        accountId: 'x',
        sellerId: 'y',
        marketId: 'ZZ',
      }),
    ).toEqual({ tool: 'search_products', text: 'dates', categoryId: null });
  });
});

describe(`evaluation set ${EVALUATION_VERSION} against the reply guard (decision 9)`, () => {
  it.each(EVALUATION_SET.map((item) => [item.id, item] as const))(
    '%s: no claim reaches the buyer',
    (_id, item) => {
      const shown = guardReply(item.reply).sentences.join(' ').toLowerCase();
      for (const text of item.mustNotShow) expect(shown).not.toContain(text.toLowerCase());
    },
  );
});

describe(`list parsing of ${EVALUATION_VERSION} (plan_basket)`, () => {
  it.each(LIST_PARSING_CASES.map((item) => [item.id, item] as const))(
    '%s: the expected call passes the tool schema',
    (_id, item) => {
      const parsed = parseToolCall('plan_basket', { items: item.lines });
      expect(parsed).toEqual({
        tool: 'plan_basket',
        items: item.lines.map((line) => ({ ...line, unit: line.unit ?? null })),
      });
    },
  );

  it.each(INVALID_PLAN_CALLS.map((item) => [item.id, item.input] as const))(
    '%s: is refused',
    (_id, input) => {
      expect(parseToolCall('plan_basket', input)).toBeNull();
    },
  );

  it('accepts 40 lines and keeps Persian text with the zero-width non-joiner', () => {
    const forty = Array.from({ length: 40 }, () => ({ text: 'برنج', quantity: 1 }));
    expect(parseToolCall('plan_basket', { items: forty })).not.toBeNull();
    const joined = parseToolCall('plan_basket', {
      items: [{ text: 'می\u200Cخواهم نان', quantity: 1 }],
    });
    expect(joined).toMatchObject({ items: [{ text: 'می\u200Cخواهم نان' }] });
  });

  it('declares the tool with the same limit as the parser', () => {
    const declared = TOOL_DECLARATIONS.find((tool) => tool.name === 'plan_basket');
    expect(JSON.stringify(declared?.inputSchema)).toContain('"maxItems":40');
  });
});
