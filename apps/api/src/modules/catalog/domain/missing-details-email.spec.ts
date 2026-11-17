import { missingDetailsEmail, missingDetailsLink } from './missing-details-email';

// The approved English text of the "Email sellers" mail (john, 11 Nov 2026): one subject rule, the
// product lines, no price, no deadline and no threat, and a link to the filtered Products page.

const page = 'https://seller.au.mondapac.test/products';

describe('missingDetailsEmail', () => {
  it('names the count in the subject and the singular for one product', () => {
    const one = missingDetailsEmail({
      sellerName: 'Fresh Co',
      products: [{ productName: 'Dates', missingLabels: ['Origin'] }],
      productsPage: page,
    });
    expect(one.subject).toBe('1 of your products needs more details');
    const two = missingDetailsEmail({
      sellerName: 'Fresh Co',
      products: [
        { productName: 'Dates', missingLabels: ['Origin'] },
        { productName: 'Rice', missingLabels: ['Origin', 'Storage'] },
      ],
      productsPage: page,
    });
    expect(two.subject).toBe('2 of your products need more details');
  });

  it('lists only the given products with their missing details and links to the filter', () => {
    const mail = missingDetailsEmail({
      sellerName: 'Fresh Co',
      products: [{ productName: 'Rice', missingLabels: ['Origin', 'Storage'] }],
      productsPage: page,
    });
    expect(mail.text).toContain('Hi Fresh Co,');
    expect(mail.text).toContain('- Rice: Origin, Storage');
    expect(mail.text).toContain('still on sale');
    expect(mail.text).toContain(`${page}?filter=missing-details`);
    expect(mail.text).not.toMatch(/\$|deadline|removed|removal|suspend/i);
  });

  it('greets without a name when the seller has none', () => {
    const mail = missingDetailsEmail({
      sellerName: null,
      products: [{ productName: 'Rice', missingLabels: ['Origin'] }],
      productsPage: page,
    });
    expect(mail.text.startsWith('Hi,\n')).toBe(true);
  });

  it('keeps a name or a label from breaking the layout and shortens a long list', () => {
    const mail = missingDetailsEmail({
      sellerName: 'Fresh\nCo',
      products: [
        {
          productName: 'Rice\r\nBcc: x',
          missingLabels: Array.from({ length: 10 }, (_, i) => `D${i}`),
        },
      ],
      productsPage: page,
    });
    expect(mail.text).toContain('Hi Fresh Co,');
    expect(mail.text).toContain('- Rice Bcc: x: D0, D1, D2, D3, D4, D5, D6, D7, and 2 more');
  });

  it('builds the link with the filter on any configured page', () => {
    expect(missingDetailsLink('https://s.test/a?x=1')).toBe(
      'https://s.test/a?x=1&filter=missing-details',
    );
  });
});
