import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { MAX_NOTICE_ATTEMPTS } from './certificate-expiry-notice';
import {
  MISSING_DETAILS_EMAIL_PRODUCTS_MAX,
  MissingDetailsEmail,
  missingDetailsEmailMail,
  planMissingDetailsEmails,
  type PlannedProduct,
} from './missing-details-email';

// The "Email sellers" action of the Missing details report (attributes A4-4): the approved text
// (English only, the singular subject), the 7-day throttle per seller and product, the grouping
// per seller, and the small notice state of one queued email.

const NOW = Temporal.Instant.from('2026-11-12T10:00:00Z');
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const SELLER_A = ID(0xa) as Id<'Seller'>;
const SELLER_B = ID(0xb) as Id<'Seller'>;

describe('the missing details email text', () => {
  it('is the approved text, one line per product with its missing detail names', () => {
    const mail = missingDetailsEmailMail({
      sellerName: 'Fuego Pantry',
      products: [
        { name: 'Smoked paprika 100 g', details: ['Country of origin', 'Net weight or volume'] },
        { name: 'Chipotle sauce', details: ['Allergens'] },
      ],
      productsUrl: 'https://seller.example.test/products',
    });
    expect(mail.subject).toBe('2 of your products need more details');
    expect(mail.text).toBe(
      [
        'Hi Fuego Pantry,',
        '',
        'We have added new required details for some product categories. The products below are still on sale, and nothing changes for buyers right now. The next time you update one of them, you will need to fill in these details:',
        '',
        '- Smoked paprika 100 g: Country of origin, Net weight or volume',
        '- Chipotle sauce: Allergens',
        '',
        'Adding them now takes a minute and helps buyers find and compare your products.',
        '',
        'Open your products: https://seller.example.test/products',
        '',
        'Questions? Reply to this email or contact seller support from your panel.',
        '',
        'The Mondapac team',
      ].join('\n'),
    );
  });

  it('uses the singular subject for one product', () => {
    const mail = missingDetailsEmailMail({
      sellerName: 'Nonna’s Table',
      products: [{ name: 'Passata', details: ['Storage'] }],
      productsUrl: null,
    });
    expect(mail.subject).toBe('1 of your products needs more details');
    expect(mail.text).toContain('Open your products in your seller panel.');
  });

  it('keeps every name on its line: control characters and line breaks become spaces', () => {
    const mail = missingDetailsEmailMail({
      sellerName: 'Shop\r\nBcc: x@example.test',
      products: [{ name: '  Tea\n- fake line\t', details: ['Origin\u0000'] }],
      productsUrl: null,
    });
    expect(mail.text.split('\n')[0]).toBe('Hi Shop Bcc: x@example.test,');
    expect(mail.text).toContain('\n- Tea - fake line: Origin\n');
  });

  it('greets without a name when the seller has no store name', () => {
    const mail = missingDetailsEmailMail({
      sellerName: null,
      products: [{ name: 'Tea', details: ['Origin'] }],
      productsUrl: null,
    });
    expect(mail.text.startsWith('Hi,\n')).toBe(true);
  });
});

describe('planning the emails of a selection', () => {
  const product = (n: number, over: Partial<PlannedProduct> = {}): PlannedProduct => ({
    productId: ID(0x100 + n),
    sellerId: SELLER_A,
    missing: ['origin'],
    ...over,
  });

  it('groups per seller in seller id order and keeps the selection order inside a seller', () => {
    const plan = planMissingDetailsEmails({
      requested: [ID(0x103), ID(0x101), ID(0x102)],
      found: [product(3, { sellerId: SELLER_B }), product(1), product(2)],
      recent: [],
      pendingSellers: new Set(),
      now: NOW,
    });
    expect(plan.unmatched).toEqual([]);
    expect(
      plan.sellers.map((s) => [s.sellerId, s.status, s.products.map((p) => p.productId)]),
    ).toEqual([
      [SELLER_A, 'queued', [ID(0x101), ID(0x102)]],
      [SELLER_B, 'queued', [ID(0x103)]],
    ]);
  });

  it('throttles a product of the same seller emailed in the last 7 days, not one emailed 7 days ago', () => {
    const plan = planMissingDetailsEmails({
      requested: [ID(0x101), ID(0x102), ID(0x103)],
      found: [product(1), product(2), product(3)],
      recent: [
        // Inside the window: one second short of 7 days.
        {
          sellerId: SELLER_A,
          productId: ID(0x101),
          requestedAt: NOW.subtract({ hours: 168 }).add({ seconds: 1 }),
          emailedAt: NOW.subtract({ hours: 168 }).add({ seconds: 1 }),
        },
        // Exactly 7 days: the window is over.
        {
          sellerId: SELLER_A,
          productId: ID(0x102),
          requestedAt: NOW.subtract({ hours: 168 }),
          emailedAt: NOW.subtract({ hours: 168 }),
        },
        // Another seller (the product changed hands): does not throttle this seller.
        {
          sellerId: SELLER_B,
          productId: ID(0x103),
          requestedAt: NOW.subtract({ hours: 1 }),
          emailedAt: NOW.subtract({ hours: 1 }),
        },
      ],
      pendingSellers: new Set(),
      now: NOW,
    });
    const [seller] = plan.sellers;
    expect(seller?.status).toBe('queued');
    expect(seller?.products).toEqual([
      {
        productId: ID(0x101),
        status: 'throttled',
        lastEmailedAt: NOW.subtract({ hours: 168 }).add({ seconds: 1 }),
      },
      { productId: ID(0x102), status: 'emailed', lastEmailedAt: null },
      { productId: ID(0x103), status: 'emailed', lastEmailedAt: null },
    ]);
    expect(seller?.emailed.map((p) => p.productId)).toEqual([ID(0x102), ID(0x103)]);
  });

  it('counts the window from the request time, and reports when the email went', () => {
    const requested = NOW.subtract({ hours: 168, minutes: 1 });
    const plan = planMissingDetailsEmails({
      requested: [ID(0x101), ID(0x102)],
      found: [product(1), product(2)],
      recent: [
        // Requested just over 7 days ago, sent a day later: the window is over.
        {
          sellerId: SELLER_A,
          productId: ID(0x101),
          requestedAt: requested,
          emailedAt: requested.add({ hours: 24 }),
        },
        // Requested 2 hours ago, sent an hour later: throttled, reported with the send time.
        {
          sellerId: SELLER_A,
          productId: ID(0x102),
          requestedAt: NOW.subtract({ hours: 2 }),
          emailedAt: NOW.subtract({ hours: 1 }),
        },
      ],
      pendingSellers: new Set(),
      now: NOW,
    });
    expect(plan.sellers[0]?.products).toEqual([
      { productId: ID(0x101), status: 'emailed', lastEmailedAt: null },
      { productId: ID(0x102), status: 'throttled', lastEmailedAt: NOW.subtract({ hours: 1 }) },
    ]);
  });

  it('reports the latest of several recent emails of a throttled product', () => {
    const plan = planMissingDetailsEmails({
      requested: [ID(0x101)],
      found: [product(1)],
      recent: [
        {
          sellerId: SELLER_A,
          productId: ID(0x101),
          requestedAt: NOW.subtract({ hours: 30 }),
          emailedAt: NOW.subtract({ hours: 30 }),
        },
        {
          sellerId: SELLER_A,
          productId: ID(0x101),
          requestedAt: NOW.subtract({ hours: 2 }),
          emailedAt: NOW.subtract({ hours: 2 }),
        },
      ],
      pendingSellers: new Set(),
      now: NOW,
    });
    expect(plan.sellers[0]).toMatchObject({
      status: 'throttled',
      products: [{ status: 'throttled', lastEmailedAt: NOW.subtract({ hours: 2 }) }],
    });
  });

  it('skips a complete product, a PLATFORM product, an unknown one and a repeat', () => {
    const plan = planMissingDetailsEmails({
      requested: [ID(0x101), ID(0x102), ID(0x109), ID(0x101)],
      found: [product(1, { missing: [] }), product(2, { sellerId: null })],
      recent: [],
      pendingSellers: new Set(),
      now: NOW,
    });
    expect(plan.unmatched).toEqual([
      { productId: ID(0x102), reason: 'no-seller' },
      { productId: ID(0x109), reason: 'not-found' },
    ]);
    expect(plan.sellers).toEqual([
      {
        sellerId: SELLER_A,
        status: 'skipped',
        products: [{ productId: ID(0x101), status: 'no-missing-details', lastEmailedAt: null }],
        emailed: [],
      },
    ]);
  });

  it('holds back a seller whose earlier email is still waiting to be sent', () => {
    const plan = planMissingDetailsEmails({
      requested: [ID(0x101), ID(0x102)],
      found: [product(1), product(2)],
      recent: [
        {
          sellerId: SELLER_A,
          productId: ID(0x101),
          requestedAt: NOW.subtract({ minutes: 1 }),
          emailedAt: NOW.subtract({ minutes: 1 }),
        },
      ],
      pendingSellers: new Set([SELLER_A]),
      now: NOW,
    });
    expect(plan.sellers[0]).toMatchObject({
      status: 'throttled',
      products: [{ status: 'throttled' }, { status: 'email-pending' }],
      emailed: [],
    });
    const none = planMissingDetailsEmails({
      requested: [ID(0x102)],
      found: [product(2)],
      recent: [],
      pendingSellers: new Set([SELLER_A]),
      now: NOW,
    });
    expect(none.sellers[0]).toMatchObject({ status: 'skipped', emailed: [] });
  });

  it('allows at most the product cap in one email', () => {
    expect(MISSING_DETAILS_EMAIL_PRODUCTS_MAX).toBe(100);
  });
});

describe('a queued missing details email', () => {
  const queued = () =>
    MissingDetailsEmail.queue({
      id: ID(0xe1) as Id<'MissingDetailsEmail'>,
      marketId: 'ZZ' as MarketId,
      sellerId: SELLER_A,
      productIds: [ID(0x101) as Id<'Product'>],
      requestedByAccountId: ID(0xac) as Id<'Account'>,
      subject: 's',
      text: 't',
      now: NOW,
    });

  it('is born pending at version 1, due now', () => {
    expect(queued().state).toMatchObject({
      noticeState: 'pending',
      noticeAttempts: 0,
      noticeNextAttemptAt: NOW,
      sentAt: null,
      requestedAt: NOW,
      version: 1,
    });
  });

  it('is sent once, with the time it went', () => {
    const later = NOW.add({ minutes: 1 });
    const sent = queued().sent(later);
    expect(sent?.state).toMatchObject({
      noticeState: 'sent',
      noticeAttempts: 1,
      noticeNextAttemptAt: null,
      sentAt: later,
      version: 2,
    });
    expect(sent?.sent(later)).toBeNull();
    expect(sent?.skipped()).toBeNull();
    expect(sent?.failedAt(later)).toBeNull();
  });

  it('is skipped when the seller has no usable address', () => {
    expect(queued().skipped()?.state).toMatchObject({ noticeState: 'skipped', sentAt: null });
  });

  it('is tried again after a failed send, then fails once the attempts are used up', () => {
    let email: MissingDetailsEmail | null = queued();
    for (let attempt = 1; attempt < MAX_NOTICE_ATTEMPTS; attempt += 1) {
      email = email!.failedAt(NOW);
      expect(email?.state.noticeState).toBe('pending');
      expect(email?.state.noticeAttempts).toBe(attempt);
    }
    email = email!.failedAt(NOW);
    expect(email?.state).toMatchObject({ noticeState: 'failed', noticeNextAttemptAt: null });
  });
});
