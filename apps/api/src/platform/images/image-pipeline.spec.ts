import sharp from 'sharp';
import { processImage, type ImagePipelineSpec } from './image-pipeline';

// The shared image core (catalog photos, store logos and banners). Catalog's own sizes and refusals
// are pinned in modules/catalog/infrastructure/sharp-image-processor.spec.ts; this file covers the
// parts the stores use: cover and contain boxes, the width and height minimums, and the order.

const LOGO: ImagePipelineSpec = {
  maxUploadBytes: 4 * 1024 * 1024,
  minWidth: 128,
  minHeight: 128,
  renditions: [
    { name: 'large', width: 512, height: 512, fit: 'contain' },
    { name: 'small', width: 128, height: 128, fit: 'contain' },
  ],
};

const BANNER: ImagePipelineSpec = {
  maxUploadBytes: 4 * 1024 * 1024,
  minWidth: 1200,
  minHeight: 300,
  renditions: [
    { name: 'large', width: 1536, height: 384, fit: 'cover' },
    { name: 'small', width: 768, height: 192, fit: 'cover' },
  ],
};

const picture = (
  width: number,
  height: number,
  background: string,
  format: 'jpeg' | 'png' | 'webp' = 'png',
) =>
  sharp({ create: { width, height, channels: 3, background } })
    [format]()
    .toBuffer();

const sizes = (
  result: Awaited<ReturnType<typeof processImage>>,
): [string, number, number][] | string =>
  result.ok ? result.value.map((r) => [r.name, r.width, r.height]) : result.error.code;

/** The colour at a pixel of a rendition, as a hex string. */
async function pixel(bytes: Buffer, x: number, y: number): Promise<string> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at]!, data[at + 1]!, data[at + 2]!]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('');
}

describe('processImage', () => {
  describe('a logo (contain on white, 512 and 128)', () => {
    it('makes square renditions and keeps the order the spec gave', async () => {
      const result = await processImage(await picture(1000, 600, '#cc0000'), LOGO);

      expect(sizes(result)).toEqual([
        ['large', 512, 512],
        ['small', 128, 128],
      ]);
    });

    it('pads a wide logo with white and never crops it', async () => {
      const result = await processImage(await picture(1000, 500, '#cc0000'), LOGO);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const large = result.value[0]!.bytes;
      // The picture is 512 wide and 256 tall in the middle; the top and bottom bands are white.
      expect(await pixel(large, 256, 5)).toBe('ffffff');
      expect(await pixel(large, 256, 506)).toBe('ffffff');
      expect((await pixel(large, 256, 256)).startsWith('c')).toBe(true);
      expect((await pixel(large, 3, 256)).startsWith('c')).toBe(true);
    });

    it('does not enlarge a small logo: the square shrinks to the longest side', async () => {
      const result = await processImage(await picture(200, 150, '#0066cc'), LOGO);

      expect(sizes(result)).toEqual([
        ['large', 200, 200],
        ['small', 128, 128],
      ]);
    });

    it('flattens transparency onto white', async () => {
      const transparent = await sharp({
        create: {
          width: 300,
          height: 300,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();

      const result = await processImage(transparent, LOGO);

      expect(result.ok && (await pixel(result.value[0]!.bytes, 100, 100))).toBe('ffffff');
    });

    it.each([
      ['narrower than 128', 127, 400],
      ['shorter than 128', 400, 127],
    ])('refuses a logo %s as too small', async (_name, width, height) => {
      expect(sizes(await processImage(await picture(width, height, '#fff'), LOGO))).toBe(
        'file.too-small',
      );
    });

    it('accepts exactly 128 by 128', async () => {
      expect(sizes(await processImage(await picture(128, 128, '#fff', 'webp'), LOGO))).toEqual([
        ['large', 128, 128],
        ['small', 128, 128],
      ]);
    });
  });

  describe('a banner (cover, 4 to 1, 1536 and 768 wide)', () => {
    it('crops a 3 to 1 picture to 4 to 1 at the centre', async () => {
      const wide = await sharp({
        create: { width: 3000, height: 1000, channels: 3, background: '#ffffff' },
      })
        .composite([
          {
            input: await picture(3000, 100, '#00aa00'),
            top: 450,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

      const result = await processImage(wide, BANNER);

      expect(sizes(result)).toEqual([
        ['large', 1536, 384],
        ['small', 768, 192],
      ]);
      if (!result.ok) return;
      // The green stripe sits in the middle rows of the picture and survives the crop.
      expect((await pixel(result.value[0]!.bytes, 700, 192)).startsWith('0')).toBe(true);
    });

    it('does not enlarge: a 1200 by 600 picture gives a 1200 by 300 banner', async () => {
      const result = await processImage(await picture(1200, 600, '#336699', 'jpeg'), BANNER);

      expect(sizes(result)).toEqual([
        ['large', 1200, 300],
        ['small', 768, 192],
      ]);
    });

    it.each([
      ['narrower than 1200', 1199, 600],
      ['shorter than 300', 1600, 299],
    ])('refuses a banner %s as too small', async (_name, width, height) => {
      expect(sizes(await processImage(await picture(width, height, '#fff'), BANNER))).toBe(
        'file.too-small',
      );
    });

    it('measures a turned picture by what it shows: orientation 6 swaps width and height', async () => {
      const tall = await sharp(await picture(400, 1300, '#fff', 'jpeg'))
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer();

      // 400 by 1300 stored, shown as 1300 by 400: wide enough and tall enough.
      expect(sizes(await processImage(tall, BANNER))).toEqual([
        ['large', 1300, 325],
        ['small', 768, 192],
      ]);
    });
  });

  it('writes metadata-free JPEGs', async () => {
    const tagged = await sharp(await picture(600, 600, '#fff', 'jpeg'))
      .withMetadata({ exif: { IFD0: { Copyright: 'someone' } } })
      .jpeg()
      .toBuffer();

    const result = await processImage(tagged, LOGO);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const rendition of result.value) {
      const meta = await sharp(rendition.bytes).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
    }
  });

  it('refuses the upload before decoding when it is empty, too large or of another type', async () => {
    const small = { ...LOGO, maxUploadBytes: 100 };

    expect(sizes(await processImage(Buffer.alloc(0), LOGO))).toBe('file.unreadable');
    expect(sizes(await processImage(await picture(400, 400, '#fff'), small))).toBe(
      'file.too-large',
    );
    expect(sizes(await processImage(Buffer.from('GIF89a......'), LOGO))).toBe(
      'file.unsupported-type',
    );
  });

  describe('the decode queue (Hassan H2)', () => {
    it('refuses an upload past 2 running and 8 waiting, before decoding it, and recovers', async () => {
      const bytes = await picture(600, 600, '#336699', 'jpeg');
      const results = await Promise.all(
        Array.from({ length: 12 }, () => processImage(bytes, LOGO)),
      );

      // Two decode at once and eight wait; the last two are refused at once.
      expect(results.slice(0, 10).every((r) => r.ok)).toBe(true);
      expect(results.slice(10).map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
        'file.busy',
        'file.busy',
      ]);

      // The queue drained: the next upload is decoded again.
      expect((await processImage(bytes, LOGO)).ok).toBe(true);
    });

    it('answers the cheap refusals before the queue: a too large or unsupported upload is never busy', async () => {
      const bytes = await picture(600, 600, '#336699', 'jpeg');
      const flood = Array.from({ length: 10 }, () => processImage(bytes, LOGO));
      const refused = await Promise.all([
        processImage(Buffer.alloc(5 * 1024 * 1024), LOGO),
        processImage(Buffer.from('GIF89a-not-allowed'), LOGO),
      ]);
      expect(refused.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
        'file.too-large',
        'file.unsupported-type',
      ]);
      await Promise.all(flood);
    });
  });
});
