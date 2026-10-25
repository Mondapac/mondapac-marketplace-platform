import sharp from 'sharp';
import { SharpImageProcessor } from './sharp-image-processor';

// Catalog's photo processing (slice 13), pinned so that moving the shared core to
// `platform/images` changes nothing a seller or a buyer can see: the same three sizes in the same
// order, the same refusal codes, no metadata in any output.

const processor = new SharpImageProcessor();

const solid = (width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'png') =>
  sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 120, b: 90, alpha: 0.5 } },
  })
    [format]()
    .toBuffer();

describe('catalog SharpImageProcessor', () => {
  it('answers thumb, medium and large JPEGs that fit 240, 800 and 1600 without enlarging', async () => {
    const result = await processor.process(await solid(2000, 1000));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => [r.size, r.width, r.height])).toEqual([
      ['thumb', 240, 120],
      ['medium', 800, 400],
      ['large', 1600, 800],
    ]);
    for (const rendition of result.value) {
      expect((await sharp(rendition.bytes).metadata()).format).toBe('jpeg');
    }
  });

  it('never enlarges a small photo', async () => {
    const result = await processor.process(await solid(300, 200, 'webp'));

    expect(result.ok && result.value.map((r) => [r.size, r.width, r.height])).toEqual([
      ['thumb', 240, 160],
      ['medium', 300, 200],
      ['large', 300, 200],
    ]);
  });

  it('applies the orientation and drops every metadata block', async () => {
    const tagged = await sharp(await solid(400, 300, 'jpeg'))
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'someone' } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();

    const result = await processor.process(tagged);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const large = result.value.at(-1)!;
    expect([large.width, large.height]).toEqual([300, 400]);
    const meta = await sharp(large.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it.each([
    { name: 'an empty body', bytes: Buffer.alloc(0), code: 'file.unreadable' },
    {
      name: 'an SVG',
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      code: 'file.unsupported-type',
    },
    {
      name: 'a truncated PNG',
      bytes: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
      code: 'file.unreadable',
    },
    {
      name: 'more than 4 MiB',
      bytes: Buffer.alloc(4 * 1024 * 1024 + 1, 1),
      code: 'file.too-large',
    },
  ])('refuses $name with $code', async ({ bytes, code }) => {
    expect(await processor.process(bytes)).toEqual({ ok: false, error: { code } });
  });

  it('refuses a photo whose longest side is under 200 pixels', async () => {
    expect(await processor.process(await solid(199, 150))).toEqual({
      ok: false,
      error: { code: 'file.too-small' },
    });
    expect((await processor.process(await solid(200, 20))).ok).toBe(true);
  });

  it('refuses a picture above 12000 pixels a side or 24 million pixels', async () => {
    const wide = await sharp({
      create: { width: 12001, height: 10, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const big = await sharp({
      create: { width: 6000, height: 4001, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    expect(await processor.process(wide)).toEqual({
      ok: false,
      error: { code: 'file.too-many-pixels' },
    });
    expect(await processor.process(big)).toEqual({
      ok: false,
      error: { code: 'file.too-many-pixels' },
    });
  });

  it('refuses an animated picture', async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 300, height: 300, channels: 3, background } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame('#fff'), await frame('#000')], {
      join: { animated: true },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();

    expect(await processor.process(animated)).toEqual({
      ok: false,
      error: { code: 'file.unsupported-type' },
    });
  });
});
