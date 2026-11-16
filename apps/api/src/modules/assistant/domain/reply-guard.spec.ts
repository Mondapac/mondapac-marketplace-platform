import { EVALUATION_SET, EVALUATION_VERSION } from './evaluation-set';
import { maskPersonalData, MASKED } from './personal-data';
import { guardReply, MAX_REPLY_CHARACTERS } from './reply-guard';
import { cardRefOf } from './cards';
import { storedCardOf } from './conversation';
import { parseToolCall, TOOL_DECLARATIONS, toolDeclarationsFor } from './tools';

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
    ]);
  });

  it('declares the cart tools only under the cart-suggestions scope', () => {
    expect(toolDeclarationsFor('read-only')).toBe(TOOL_DECLARATIONS);
    const names = toolDeclarationsFor('cart-suggestions').map((tool) => tool.name);
    expect(names).toContain('get_cart');
    expect(names.filter((name) => name === 'suggest_cart_change')).toHaveLength(1);
  });

  describe('cart calls (stage 1, S1-B1)', () => {
    const OFFER = '0199aaaa-0000-7000-8000-0000000000f1';
    const LINE = '0199aaaa-0000-7000-8000-0000000000c1';
    const cart = (input: unknown) =>
      parseToolCall('suggest_cart_change', input, 'cart-suggestions');

    it('answers "not ready" and reads nothing under the read-only scope', () => {
      expect(parseToolCall('suggest_cart_change', { action: 'add', offer_id: OFFER })).toEqual({
        tool: 'suggest_cart_change',
        change: null,
      });
      expect(parseToolCall('get_cart', {})).toBeNull();
      expect(parseToolCall('get_cart', {}, 'cart-suggestions')).toEqual({ tool: 'get_cart' });
    });

    it('accepts an add (default quantity 1), a quantity change and a removal', () => {
      expect(cart({ action: 'add', offer_id: OFFER })).toEqual({
        tool: 'suggest_cart_change',
        change: { action: 'add', offerId: OFFER, quantity: 1 },
      });
      expect(cart({ action: 'set_quantity', line_id: LINE, quantity: 999 })).toEqual({
        tool: 'suggest_cart_change',
        change: { action: 'set-quantity', lineId: LINE, quantity: 999 },
      });
      expect(cart({ action: 'remove', line_id: LINE })).toEqual({
        tool: 'suggest_cart_change',
        change: { action: 'remove', lineId: LINE },
      });
    });

    it.each([
      ['no action', { offer_id: OFFER }],
      ['an unknown action', { action: 'checkout', offer_id: OFFER }],
      ['a bad offer id', { action: 'add', offer_id: 'ghee' }],
      ['a zero quantity', { action: 'add', offer_id: OFFER, quantity: 0 }],
      ['a fractional quantity', { action: 'add', offer_id: OFFER, quantity: 1.5 }],
      ['a string quantity', { action: 'add', offer_id: OFFER, quantity: '2' }],
      ['a quantity over 999', { action: 'add', offer_id: OFFER, quantity: 1000 }],
      ['a set without quantity', { action: 'set_quantity', line_id: LINE }],
      ['a removal of an offer', { action: 'remove', offer_id: OFFER }],
      ['an extra field (a price)', { action: 'add', offer_id: OFFER, price: 1 }],
      ['an account id', { action: 'remove', line_id: LINE, account_id: LINE }],
      ['a negative quantity', { action: 'add', offer_id: OFFER, quantity: -2 }],
      ['a set with an offer id', { action: 'set_quantity', offer_id: OFFER, quantity: 2 }],
      ['a removal with a quantity', { action: 'remove', line_id: LINE, quantity: 1 }],
      ['an array', [{ action: 'add', offer_id: OFFER }]],
      ['a string', 'add ghee'],
      ['null', null],
    ])('refuses %s', (_name, input) => {
      expect(cart(input)).toBeNull();
    });

    it('stores a cart-action card as its product and a cart card as the cart page link', () => {
      const units = [] as const;
      expect(
        cardRefOf({
          kind: 'cart-action',
          action: 'add',
          offerId: OFFER,
          productId: null,
          sellerId: null,
          sellerName: null,
          name: null,
          lineId: null,
          currentQuantity: null,
          quantity: 1,
          limited: false,
          cartFull: null,
          units,
          cartMode: 'multi-store',
          otherStore: false,
        }),
      ).toBe(`product:${OFFER}`);
      expect(cardRefOf({ kind: 'cart', lineCount: 0, total: null, groups: [] })).toBe('page:cart');
      expect(storedCardOf(`product:${OFFER}`)).toEqual({ kind: 'product', offerId: OFFER });
      expect(storedCardOf('page:cart')).toEqual({ kind: 'page', page: 'cart' });
    });
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
