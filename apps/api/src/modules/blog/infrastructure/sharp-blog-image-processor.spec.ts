import sharp from 'sharp';
import { SharpBlogImageProcessor } from './sharp-blog-image-processor';

// The blog's picture processing on the real shared pipeline: the two sizes in order, never
// enlarged, the least size, the type taken from the content, and no metadata in any output.

const processor = new SharpBlogImageProcessor();

const solid = (width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'png') =>
  sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 120, b: 90, alpha: 0.5 } },
  })
    [format]()
    .toBuffer();

describe('blog SharpBlogImageProcessor', () => {
  it('answers a large JPEG that fits 1600 and a thumb that fits 400, in that order', async () => {
    const result = await processor.process(await solid(3000, 1500));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => [r.size, r.width, r.height])).toEqual([
      ['large', 1600, 800],
      ['thumb', 400, 200],
    ]);
    for (const rendition of result.value) {
      const meta = await sharp(rendition.bytes).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
    }
  });

  it('never enlarges a picture smaller than the large box', async () => {
    const result = await processor.process(await solid(600, 900, 'webp'));

    expect(result.ok && result.value.map((r) => [r.size, r.width, r.height])).toEqual([
      ['large', 600, 900],
      ['thumb', 267, 400],
    ]);
  });

  it('drops the EXIF of a JPEG upload', async () => {
    const withExif = await sharp(await solid(800, 600, 'jpeg'))
      .withMetadata({ exif: { IFD0: { Copyright: 'someone' } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await processor.process(withExif);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const rendition of result.value) {
      expect((await sharp(rendition.bytes).metadata()).exif).toBeUndefined();
    }
  });

  it('refuses a picture whose longest side is under 400 pixels, and a file that is not a picture', async () => {
    expect(await processor.process(await solid(399, 300))).toEqual({
      ok: false,
      error: { code: 'file.too-small' },
    });
    expect(await processor.process(Buffer.from('GIF89a not a picture'))).toEqual({
      ok: false,
      error: { code: 'file.unsupported-type' },
    });
  });
});
