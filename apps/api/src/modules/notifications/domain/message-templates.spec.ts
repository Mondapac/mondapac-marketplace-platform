import { fill, templateFor } from './message-templates';
import { orderConfirmationMail, orderShippedMail, sellerNewOrderMail } from './order-mail';

describe('message templates', () => {
  it('picks the exact locale, then its language, then English', () => {
    expect(templateFor('order-shipped', 'en-AU')).toBe(templateFor('order-shipped', 'en'));
    // A Market locale with no text of its own (ZZ is ja-JP) falls back to English.
    expect(templateFor('order-shipped', 'ja-JP')).toBe(templateFor('order-shipped', 'en'));
    expect(templateFor('order-shipped', '')).toBe(templateFor('order-shipped', 'en'));
    expect(templateFor('order-shipped', 'constructor')).toBe(templateFor('order-shipped', 'en'));
    expect(templateFor('order-shipped', '__proto__')).toBe(templateFor('order-shipped', 'en'));
  });

  it('fills a slot once: a value that holds a slot is not expanded again', () => {
    expect(fill('Hello {a} {b}', { a: '{b}', b: 'x' })).toBe('Hello {b} x');
    expect(fill('Hello {missing}', {})).toBe('Hello {missing}');
  });

  it('leaves no unfilled slot in any template', () => {
    const mails = [
      orderConfirmationMail({ orderId: 'o1', lines: [], orderUrl: 'https://s.test/o1' }),
      sellerNewOrderMail({ sellerOrderId: 's1', lines: [] }),
      orderShippedMail({ orderId: 'o1', carrier: 'AP', trackingRef: null, orderUrl: 'u' }),
    ];
    for (const mail of mails) expect(`${mail.subject}\n${mail.text}`).not.toMatch(/\{\w+\}/);
    // Seller text that looks like a slot or a replacement pattern stays inert.
    const odd = orderShippedMail({
      orderId: 'o1',
      carrier: '{orderId} $&',
      trackingRef: null,
      orderUrl: 'u',
    });
    expect(odd.text).toContain('Carrier: {orderId} $&');
  });

  it('keeps the shipped mail layout with and without a tracking number', () => {
    const base = { orderId: 'o1', carrier: 'Australia Post', orderUrl: 'https://s.test/o1' };
    expect(orderShippedMail({ ...base, trackingRef: 'AP1' }).text).toBe(
      [
        'Shipped',
        '',
        'Good news: a seller has shipped part of your order.',
        '',
        'Order reference: o1',
        'Carrier: Australia Post',
        'Tracking number: AP1',
        '',
        'View your order (you will be asked to sign in):',
        'https://s.test/o1',
        '',
      ].join('\n'),
    );
    expect(orderShippedMail({ ...base, trackingRef: null }).text).toContain(
      'Carrier: Australia Post\n\nView your order',
    );
  });
});
