import { createTranslator } from 'next-intl';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import type { CertificationBadge, ProductDetail, ProductOffer } from '../src/storefront/types.ts';

// The request: its Host header and whether hosts are listed (none on sample data).
const request = vi.hoisted((): { host: string | null; listed: boolean } => ({
  host: 'shop.example',
  listed: true,
}));
// The product the route reads; undefined falls back to the sample.
const read = vi.hoisted((): { product?: unknown } => ({}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(request.host === null ? {} : { host: request.host })),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(createTranslator({ locale: 'en', messages, namespace: namespace as 'store' })),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
}));
vi.mock('../src/storefront/config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  storefrontApiConfig: () =>
    request.listed
      ? {
          apiBaseUrl: 'https://api.shop.example',
          hosts: [{ origin: 'https://shop.example', host: 'shop.example', marketId: 'AU' }],
          clientAddressKey: null,
        }
      : null,
}));
vi.mock('../src/storefront/source.ts', async (importOriginal) => {
  const actual = await importOriginal<object>();
  const { sampleProduct } = await import('../src/storefront/sample-product.ts');
  const { sampleUnavailableProduct } = await import('../src/storefront/sample-unavailable.ts');
  return {
    ...actual,
    loadProduct: (id: string) => Promise.resolve(read.product ?? sampleProduct(id)),
    loadUnavailableProduct: (id: string) => Promise.resolve(sampleUnavailableProduct(id)),
  };
});
vi.mock('../src/storefront/listing-source.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  liveCategory: () => Promise.resolve(undefined),
  liveProducts: () => Promise.resolve(undefined),
}));

const {
  breadcrumbStructuredData,
  decimalPrice,
  homeStructuredData,
  jsonLdText,
  productPageStructuredData,
  productStructuredData,
} = await import('../src/seo/structured-data.ts');
const { JsonLd } = await import('../src/seo/json-ld.tsx');

const ORIGIN = 'https://shop.example';
const URL_ = `${ORIGIN}/p/lamb`;

const HALAL: CertificationBadge = {
  type: 'halal',
  label: 'Halal certified',
  basis: 'SELLER',
  sellerClaim: false,
  issuer: 'Halal Authority Australia',
  validUntil: '2027-03-31',
  verifiedWithIssuer: true,
};

function offer(over: Partial<ProductOffer> = {}): ProductOffer {
  return {
    id: 'o1',
    seller: { id: 'kedron', name: 'Kedron Halal Butcher', certificates: [] },
    price: { amount: 2450, currency: 'AUD' },
    certifications: [],
    ...over,
  };
}

function product(
  over: Partial<ProductDetail> = {},
  first: Partial<ProductOffer> = {},
): ProductDetail {
  return {
    id: 'lamb',
    name: 'Lamb shoulder',
    category: 'meat',
    description: 'Fresh lamb shoulder from local farms.',
    specifications: [],
    photos: ['/s/kedron/images/a/large', 'https://cdn.example/b.jpg', 'javascript:alert(1)'],
    offers: [offer(first), offer({ id: 'o2', price: { amount: 1999, currency: 'AUD' } })],
    similar: [],
    ...over,
  };
}

type Node = Record<string, unknown>;
const offersOf = (node: Node | null) => node?.offers as Node;

/** The JSON-LD of a rendered element tree, or null when it renders no script. */
function scriptOf(element: ReactNode): Node | null {
  const html = renderToStaticMarkup(element as ReactElement);
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html);
  return match ? (JSON.parse(match[1]!) as Node) : null;
}

/** The JsonLd element a route returns first in its fragment, if any. */
function jsonLdOf(page: unknown): ReactNode {
  if (!isValidElement(page)) return null;
  const children = (page.props as { children?: unknown }).children;
  const first = Array.isArray(children) ? (children[0] as unknown) : null;
  return isValidElement(first) && first.type === JsonLd ? first : null;
}

describe('Product structured data', () => {
  it('gives the required fields and ONE Offer for the buy-box offer', () => {
    const node = productStructuredData(product(), ORIGIN, URL_)!;
    expect(node['@type']).toBe('Product');
    expect(node.name).toBe('Lamb shoulder');
    expect(node.description).toBe('Fresh lamb shoulder from local farms.');
    // Absolute photos only; a bad scheme is dropped.
    expect(node.image).toEqual([
      'https://shop.example/s/kedron/images/a/large',
      'https://cdn.example/b.jpg',
    ]);
    const o = offersOf(node);
    expect(Array.isArray(o)).toBe(false);
    expect(o['@type']).toBe('Offer');
    expect(JSON.stringify(node)).not.toContain('AggregateOffer');
    expect(o).toMatchObject({
      url: URL_,
      price: '24.50',
      priceCurrency: 'AUD',
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
      priceSpecification: { price: '24.50', priceCurrency: 'AUD', valueAddedTaxIncluded: true },
      seller: { '@type': 'Organization', name: 'Kedron Halal Butcher', url: `${ORIGIN}/s/kedron` },
    });
    // No brand, GTIN or SKU: the read has none.
    expect(node).not.toHaveProperty('brand');
    expect(node).not.toHaveProperty('gtin');
    expect(node).not.toHaveProperty('sku');
  });

  it('matches the visible price of the buy box, in the currency of the offer', () => {
    // The page shows offers[0].price; the markup reads the same field.
    const p = product({}, { price: { amount: 105, currency: 'AUD' } });
    expect(offersOf(productStructuredData(p, ORIGIN, URL_)).price).toBe('1.05');
    // A currency without minor units is not divided.
    const yen = product({}, { price: { amount: 1200, currency: 'JPY' } });
    expect(offersOf(productStructuredData(yen, ORIGIN, URL_))).toMatchObject({
      price: '1200',
      priceCurrency: 'JPY',
    });
    expect(decimalPrice({ amount: 7, currency: 'NZD' })).toBe('0.07');
  });

  it('says out of stock when the buy-box offer has no units, in stock otherwise', () => {
    const out = productStructuredData(product({}, { lowStock: 0 }), ORIGIN, URL_);
    expect(offersOf(out).availability).toBe('https://schema.org/OutOfStock');
    const low = productStructuredData(product({}, { lowStock: 2 }), ORIGIN, URL_);
    expect(offersOf(low).availability).toBe('https://schema.org/InStock');
  });

  it('gives nothing at all for a product without a positive price', () => {
    for (const amount of [0, -100]) {
      const p = product({}, { price: { amount, currency: 'AUD' } });
      expect(productStructuredData(p, ORIGIN, URL_)).toBeNull();
      expect(
        productPageStructuredData(p, [{ name: 'Home', path: '/' }, { name: 'x' }], ORIGIN, URL_),
      ).toEqual([]);
    }
  });
});

describe('hasCertification', () => {
  it('lists only the certified badges of the buy-box offer', () => {
    const node = productStructuredData(product({}, { certifications: [HALAL] }), ORIGIN, URL_)!;
    expect(node.hasCertification).toEqual([
      {
        '@type': 'Certification',
        name: 'Halal certified',
        issuedBy: { '@type': 'Organization', name: 'Halal Authority Australia' },
        expires: '2027-03-31',
      },
    ]);
  });

  it('never comes from product text, a declaration, a badge without issuer, or another offer', () => {
    const text = product({
      name: 'Halal lamb shoulder',
      description: 'Certified halal by a halal authority. HALAL.',
    });
    expect(productStructuredData(text, ORIGIN, URL_)).not.toHaveProperty('hasCertification');
    const declared = product({}, { certifications: [{ ...HALAL, sellerClaim: true }] });
    expect(productStructuredData(declared, ORIGIN, URL_)).not.toHaveProperty('hasCertification');
    // Sample badges carry no sellerClaim: unknown is not certified (fail closed).
    const unknown = product({}, { certifications: [{ type: 'halal', label: 'Halal certified' }] });
    expect(productStructuredData(unknown, ORIGIN, URL_)).not.toHaveProperty('hasCertification');
    const { issuer, ...noIssuer } = HALAL;
    expect(issuer).toBeDefined();
    const anonymous = product({}, { certifications: [noIssuer] });
    expect(productStructuredData(anonymous, ORIGIN, URL_)).not.toHaveProperty('hasCertification');
    const other = product({
      offers: [offer(), offer({ id: 'o2', certifications: [HALAL] })],
    });
    expect(productStructuredData(other, ORIGIN, URL_)).not.toHaveProperty('hasCertification');
  });
});

describe('BreadcrumbList', () => {
  it('numbers the steps, gives absolute items and leaves the last item without a link', () => {
    const node = breadcrumbStructuredData(
      [{ name: 'Home', path: '/' }, { name: 'Meat', path: '/c/meat' }, { name: 'Lamb' }],
      ORIGIN,
    );
    expect(node).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Meat', item: `${ORIGIN}/c/meat` },
        { '@type': 'ListItem', position: 3, name: 'Lamb' },
      ],
    });
  });

  it('gives nothing for fewer than two steps', () => {
    expect(breadcrumbStructuredData([{ name: 'Home', path: '/' }], ORIGIN)).toBeNull();
  });
});

describe('Home structured data', () => {
  it('gives WebSite and OnlineStore, with no business fields and no logo yet', () => {
    const [site, store] = homeStructuredData('Mondapac', ORIGIN);
    expect(site).toEqual({ '@type': 'WebSite', name: 'Mondapac', url: `${ORIGIN}/` });
    expect(store).toEqual({ '@type': 'OnlineStore', name: 'Mondapac', url: `${ORIGIN}/` });
  });
});

describe('Escaping', () => {
  const attack = '</script><script>alert(1)</script><!-- & \u2028';

  it('keeps any text inside the JSON: no `<`, `>` or `&` reaches the script', () => {
    const text = jsonLdText(productStructuredData(product({ name: attack }), ORIGIN, URL_)!);
    expect(text).not.toMatch(/[<>&\u2028\u2029]/u);
    expect((JSON.parse(text) as Node).name).toBe(attack.replace(/\s+/gu, ' ').trim());
  });

  it('renders one script whose body parses back to the same value', () => {
    const html = renderToStaticMarkup(
      JsonLd({ data: productStructuredData(product({ name: attack }), ORIGIN, URL_) }),
    );
    // The script body itself holds no `<`, `>` or `&`, whatever React does with script text.
    expect(/<script[^>]*>([\s\S]*)<\/script>/u.exec(html)![1]).not.toMatch(/[<>&]/u);
    expect(html.match(/<script/gu)).toHaveLength(1);
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
    expect(html).not.toContain('alert(1)</script>');
    expect(
      (scriptOf(JsonLd({ data: [{ '@type': 'WebSite', name: attack }] })) as Node)['@graph'],
    ).toEqual([{ '@type': 'WebSite', name: attack }]);
  });

  it('renders nothing for no data', () => {
    expect(JsonLd({ data: null })).toBeNull();
    expect(JsonLd({ data: [] })).toBeNull();
  });
});

describe('Routes', () => {
  beforeEach(() => {
    request.host = 'shop.example';
    request.listed = true;
    read.product = undefined;
  });

  const productRoute = async (id: string) => {
    const { default: route } = await import('../app/p/[id]/page.tsx');
    return route({ params: Promise.resolve({ id }) });
  };
  const categoryRoute = async (params: { category: string; sub?: string[] }, query = {}) => {
    const { default: route } = await import('../app/c/[category]/[[...sub]]/page.tsx');
    return route({ params: Promise.resolve(params), searchParams: Promise.resolve(query) });
  };

  it('gives a product page its Product and the visible crumbs, from the same read', async () => {
    read.product = product({ id: 'lamb-shoulder' });
    const data = scriptOf(jsonLdOf(await productRoute('lamb-shoulder')))!;
    const [node, crumbs] = data['@graph'] as Node[];
    expect(node!['@type']).toBe('Product');
    expect(offersOf(node!)).toMatchObject({ price: '24.50', url: `${ORIGIN}/p/lamb-shoulder` });
    // Home, the category, the product: "Browse products" is a button, not a page.
    expect(crumbs).toMatchObject({
      itemListElement: [
        { position: 1, name: 'Home', item: `${ORIGIN}/` },
        { position: 2, name: 'Meat', item: `${ORIGIN}/c/meat` },
        { position: 3, name: 'Lamb shoulder' },
      ],
    });
    expect(JSON.stringify(crumbs)).not.toContain('Browse');
  });

  it('gives no script for a product without a price, a removed product or an unknown host', async () => {
    read.product = product({ id: 'free' }, { price: { amount: 0, currency: 'AUD' } });
    expect(scriptOf(jsonLdOf(await productRoute('free')))).toBeNull();
    read.product = undefined;
    // A removed product renders its own view, without a fragment or script.
    expect(jsonLdOf(await productRoute('lamb-leg-roast'))).toBeNull();
    read.product = product({ id: 'lamb-shoulder' });
    request.host = 'evil.example';
    expect(scriptOf(jsonLdOf(await productRoute('lamb-shoulder')))).toBeNull();
    // No listed hosts at all (sample data).
    request.host = 'shop.example';
    request.listed = false;
    expect(scriptOf(jsonLdOf(await productRoute('lamb-shoulder')))).toBeNull();
  });

  it('gives a category and a subcategory their visible crumbs', async () => {
    const top = scriptOf(jsonLdOf(await categoryRoute({ category: 'meat' })));
    expect(top).toMatchObject({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { position: 1, name: 'Home', item: `${ORIGIN}/` },
        { position: 2, name: 'Meat' },
      ],
    });
    expect((top!.itemListElement as Node[])[1]).not.toHaveProperty('item');
    const sub = scriptOf(jsonLdOf(await categoryRoute({ category: 'meat', sub: ['lamb'] })));
    expect(sub).toMatchObject({
      itemListElement: [
        { position: 1, name: 'Home', item: `${ORIGIN}/` },
        { position: 2, name: 'Meat', item: `${ORIGIN}/c/meat` },
        { position: 3, name: 'Lamb' },
      ],
    });
  });

  it('gives no crumbs on a filtered or re-ordered listing (noindex) or an unknown host', async () => {
    expect(
      scriptOf(jsonLdOf(await categoryRoute({ category: 'meat' }, { special: '1' }))),
    ).toBeNull();
    expect(
      scriptOf(jsonLdOf(await categoryRoute({ category: 'meat' }, { sort: 'price-asc' }))),
    ).toBeNull();
    request.host = 'evil.example';
    expect(scriptOf(jsonLdOf(await categoryRoute({ category: 'meat' })))).toBeNull();
  });

  it('gives the home page WebSite and OnlineStore on a listed host only', async () => {
    const { default: home } = await import('../app/page.tsx');
    const data = scriptOf(jsonLdOf(await home()))!;
    expect((data['@graph'] as Node[]).map((n) => n['@type'])).toEqual(['WebSite', 'OnlineStore']);
    expect(JSON.stringify(data)).not.toMatch(/legalName|taxID|address|contactPoint/u);
    request.host = 'evil.example';
    expect(scriptOf(jsonLdOf(await home()))).toBeNull();
  });
});
