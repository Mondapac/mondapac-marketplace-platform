// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { Gallery } from '../src/product/gallery.tsx';
import { CardPhoto } from '../src/home/card-photo.tsx';
import { cardOf } from '../src/storefront/home-source.ts';
import { photoSetOf, photoUrlBuilder, renditionSize } from '../src/storefront/photos.ts';
import { productDetailOf, type ProductDetailBody } from '../src/storefront/product-detail.ts';
import { productStructuredData } from '../src/seo/structured-data.ts';
import { storefrontCsp } from '../src/security/storefront-csp.ts';
import messages from '../messages/en.json';

// SEO package 6B: photo markup (srcset, sizes, dimensions, alt) and the photo URLs the JSON-LD uses.

const PRODUCT = '01990000-0000-7000-8000-000000000900';
const P1 = '01990000-0000-7000-8000-0000000000a1';
const P2 = '01990000-0000-7000-8000-0000000000a2';
const ORIGIN = 'https://img.example.com';
const photo = photoUrlBuilder(ORIGIN, 'AU')!;
const url = (id: string, size: string) =>
  `${ORIGIN}/catalog/public-images/AU/${PRODUCT}/${id}/${size}`;
const ref = (imageId: string, width = 1600, height = 1200) => ({
  imageId,
  width,
  height,
  alt: 'Lamb shoulder',
});

describe('rendition sizes', () => {
  it('fit 240, 800 and 1600 on the longest side without enlarging', () => {
    expect(renditionSize({ width: 1600, height: 1200 }, 'thumb')).toEqual({
      width: 240,
      height: 180,
    });
    expect(renditionSize({ width: 1600, height: 1200 }, 'medium')).toEqual({
      width: 800,
      height: 600,
    });
    expect(renditionSize({ width: 1200, height: 1600 }, 'medium')).toEqual({
      width: 600,
      height: 800,
    });
    expect(renditionSize({ width: 300, height: 200 }, 'large')).toEqual({
      width: 300,
      height: 200,
    });
    expect(renditionSize({ width: 300, height: 200 }, 'medium')).toEqual({
      width: 300,
      height: 200,
    });
  });

  it('give a srcset with real widths, one entry per width', () => {
    const big = photoSetOf(photo, PRODUCT, ref(P1), 'medium')!;
    expect(big.srcSet).toBe(
      `${url(P1, 'thumb')} 240w, ${url(P1, 'medium')} 800w, ${url(P1, 'large')} 1600w`,
    );
    expect([big.width, big.height]).toEqual([800, 600]);
    expect(big.largest).toBe(url(P1, 'large'));
    const small = photoSetOf(photo, PRODUCT, ref(P1, 300, 200), 'large')!;
    expect(small.srcSet).toBe(`${url(P1, 'thumb')} 240w, ${url(P1, 'large')} 300w`);
  });
});

describe('picture sources', () => {
  it('list AVIF then WebP, each over the same widths as the JPEG', () => {
    const set = photoSetOf(photo, PRODUCT, ref(P1), 'medium')!;
    expect(set.sources).toEqual([
      {
        type: 'image/avif',
        srcSet: `${url(P1, 'thumb.avif')} 240w, ${url(P1, 'medium.avif')} 800w, ${url(P1, 'large.avif')} 1600w`,
      },
      {
        type: 'image/webp',
        srcSet: `${url(P1, 'thumb.webp')} 240w, ${url(P1, 'medium.webp')} 800w, ${url(P1, 'large.webp')} 1600w`,
      },
    ]);
    // The JPEG list, the largest URL (sitemap, JSON-LD) and the size are unchanged.
    expect(set.largest).toBe(url(P1, 'large'));
  });
});

describe('card photo', () => {
  it('has srcset, sizes, width and height from the API size', () => {
    const card = cardOf(
      { productId: PRODUCT, name: 'Lamb shoulder', categoryIds: [], primaryImage: ref(P1) },
      new Map(),
      photo,
    )!;
    const { container } = render(
      <CardPhoto src={card.imageUrl!} category="meat" set={card.imageSet} />,
    );
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(url(P1, 'medium'));
    expect(img.getAttribute('srcset')).toContain('1600w');
    expect(img.getAttribute('sizes')).toMatch(/50vw$/u);
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['800', '600']);
    const sources = [...container.querySelectorAll('picture > source')];
    expect(sources.map((s) => s.getAttribute('type'))).toEqual(['image/avif', 'image/webp']);
    expect(sources[0]!.getAttribute('srcset')).toContain(`${url(P1, 'large.avif')} 1600w`);
    expect(sources[0]!.getAttribute('sizes')).toBe(img.getAttribute('sizes'));
    expect(img.parentElement!.tagName).toBe('PICTURE');
    expect(img.nextElementSibling).toBeNull();
  });

  it('is a plain img without a set', () => {
    const { container } = render(<CardPhoto src="/placeholders/meat.jpg" category="meat" />);
    expect(container.querySelector('picture')).toBeNull();
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/placeholders/meat.jpg');
  });
});

const body = (images: unknown): ProductDetailBody => ({
  productId: PRODUCT,
  name: 'Lamb shoulder',
  shortDescription: null,
  description: null,
  categoryIds: [],
  images,
  offers: [
    {
      offerId: '01990000-0000-7000-8000-000000001001',
      sellerId: '01990000-0000-7000-8000-000000005001',
      seller: { storeName: 'Kedron Butchers' },
      units: [
        {
          variantId: '01990000-0000-7000-8000-000000002001',
          label: null,
          price: { amount: '1890', currency: 'AUD' },
          taxInclusive: true,
          special: null,
          stock: { status: 'in-stock', onlyLeft: null },
        },
      ],
    },
  ],
});
const labels = { minimum: (a: string) => a, noMinimum: 'none' };

describe('gallery photos', () => {
  const detail = productDetailOf(body([ref(P1), ref(P2, 1200, 1600)]), 'en', labels, photo)!;
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Gallery
        name={detail.name}
        category="meat"
        photos={detail.photos}
        thumbs={detail.photoThumbs}
        sets={detail.photoSets}
        certifications={[]}
        special={false}
      />
    </NextIntlClientProvider>,
  );
  const images = [...container.querySelectorAll<HTMLImageElement>('.gslide img')];

  it('have srcset, sizes, and the width and height of the large photo', () => {
    expect(images).toHaveLength(2);
    expect(images[0]!.getAttribute('srcset')).toBe(
      `${url(P1, 'thumb')} 240w, ${url(P1, 'medium')} 800w, ${url(P1, 'large')} 1600w`,
    );
    expect(images[0]!.getAttribute('sizes')).toContain('100vw');
    expect([images[0]!.getAttribute('width'), images[0]!.getAttribute('height')]).toEqual([
      '1600',
      '1200',
    ]);
    expect([images[1]!.getAttribute('width'), images[1]!.getAttribute('height')]).toEqual([
      '1200',
      '1600',
    ]);
  });

  it('are pictures: AVIF and WebP sources before the JPEG img', () => {
    const pictures = [...container.querySelectorAll('.gslide picture')];
    expect(pictures).toHaveLength(2);
    const kids = [...pictures[0]!.children].map((el) => el.tagName);
    expect(kids).toEqual(['SOURCE', 'SOURCE', 'IMG']);
    const first = pictures[0]!.querySelector('source')!;
    expect(first.getAttribute('type')).toBe('image/avif');
    expect(first.getAttribute('sizes')).toBe(images[0]!.getAttribute('sizes'));
    expect(first.getAttribute('srcset')).toContain(`${url(P1, 'large.avif')} 1600w`);
    expect(images[0]!.getAttribute('src')).toBe(url(P1, 'large'));
  });

  it('keep the priority photo and lazy-load the rest', () => {
    expect(images[0]!.getAttribute('fetchpriority')).toBe('high');
    expect(images[1]!.getAttribute('loading')).toBe('lazy');
  });

  it('use the product name, with the position on later photos', () => {
    expect(images.map((img) => img.getAttribute('alt'))).toEqual([
      'Lamb shoulder',
      'Lamb shoulder, photo 2',
    ]);
  });
});

describe('JSON-LD image list', () => {
  it('is the large photos, which the sitemap lists too', () => {
    const detail = productDetailOf(body([ref(P1), ref(P2)]), 'en', labels, photo)!;
    const node = productStructuredData(detail, 'https://shop.example', 'https://shop.example/p/x');
    expect((node as { image?: string[] }).image).toEqual([url(P1, 'large'), url(P2, 'large')]);
    expect(detail.photoSets?.map((set) => set.largest)).toEqual(detail.photos);
  });
});

describe('content security policy', () => {
  it('allows no photo origin beyond the configured one', () => {
    const policy = storefrontCsp('abc123', false, ORIGIN);
    expect(policy).toContain(ORIGIN);
    expect(policy).not.toContain('cdn');
  });
});
