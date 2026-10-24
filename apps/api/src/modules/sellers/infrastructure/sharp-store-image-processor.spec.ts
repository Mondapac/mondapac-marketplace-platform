import sharp from 'sharp';
import { SharpStoreImageProcessor } from './sharp-store-image-processor';

// Sellers' logo and banner processing (slice 12 part 2) on the shared core: sizes, minimums, the
// order of renditions and what is dropped. The core itself is pinned in platform/images.

const processor = new SharpStoreImageProcessor();

const picture = (width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'png') =>
  sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.4 } },
  })
    [format]()
    .toBuffer();

const shapes = async (kind: 'logo' | 'banner', bytes: Buffer) => {
  const result = await processor.process(kind, bytes);
  return result.ok
    ? result.value.map((r) => [r.size, r.width, r.height])
    : { refused: result.error.code };
};

describe('sellers SharpStoreImageProcessor', () => {
  it('makes a square large (512) and small (128) logo from a wide picture, never cropped', async () => {
    expect(await shapes('logo', await picture(1000, 400))).toEqual([
      ['large', 512, 512],
      ['small', 128, 128],
    ]);
  });

  it('makes a 4 to 1 banner of 1536 and 768 wide, cropped at the centre', async () => {
    expect(await shapes('banner', await picture(2400, 1200, 'jpeg'))).toEqual([
      ['large', 1536, 384],
      ['small', 768, 192],
    ]);
  });

  it('writes JPEG with no metadata, flattening transparency onto white', async () => {
    const result = await processor.process('logo', await picture(300, 300));
    if (!result.ok) throw new Error(result.error.code);

    for (const rendition of result.value) {
      const meta = await sharp(rendition.bytes).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.hasAlpha).toBe(false);
    }
  });

  it.each([
    ['a logo under 128 pixels', 'logo', 100, 300, 'file.too-small'],
    ['a banner narrower than 1200 pixels', 'banner', 1000, 400, 'file.too-small'],
    ['a banner shorter than 300 pixels', 'banner', 2000, 250, 'file.too-small'],
  ] as const)('refuses %s', async (_, kind, width, height, code) => {
    expect(await shapes(kind, await picture(width, height))).toEqual({ refused: code });
  });

  it('refuses what is not a picture, whatever its name', async () => {
    expect(await shapes('logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({
      refused: 'file.unsupported-type',
    });
    expect(await shapes('logo', Buffer.from('not an image at all'))).toEqual({
      refused: 'file.unsupported-type',
    });
  });

  it('refuses a truncated picture as unreadable', async () => {
    const whole = await picture(400, 400, 'jpeg');

    expect(await shapes('logo', whole.subarray(0, 120))).toEqual({ refused: 'file.unreadable' });
  });

  it('refuses an upload over 4 MiB', async () => {
    const big = Buffer.concat([await picture(400, 400, 'jpeg'), Buffer.alloc(4 * 1024 * 1024)]);

    expect(await shapes('logo', big)).toEqual({ refused: 'file.too-large' });
  });
});
