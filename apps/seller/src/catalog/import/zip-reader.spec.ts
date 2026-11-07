import { describe, expect, it } from 'vitest';
import { MAX_ZIP_BYTES, PHOTO_ZIP_LIMITS, sniffImage, unzipPhotos } from './photo-zip.ts';
import { MAX_PICKED_PHOTOS } from './photo-queue.ts';
import { PHOTO_MAX_INPUT_BYTES } from '../photo-limits.ts';
import { decodeEntryName, ZipError, type ZipErrorCode, type ZipLimits } from './zip-reader.ts';
import { buildZip, JPEG, PNG, WEBP, zipFile, type FixtureEntry } from './zip-fixture.ts';

const LIMITS: ZipLimits = {
  maxZipBytes: 100_000,
  maxEntries: 5,
  maxEntryBytes: 1000,
  maxTotalBytes: 3000,
};

async function refusal(
  entries: readonly FixtureEntry[],
  limits: ZipLimits = LIMITS,
  options?: Parameters<typeof buildZip>[1],
): Promise<ZipError> {
  try {
    await unzipPhotos(zipFile(buildZip(entries, options)), limits);
  } catch (error) {
    if (error instanceof ZipError) return error;
    throw error;
  }
  throw new Error('the ZIP was accepted');
}

const code = async (entries: readonly FixtureEntry[], limits?: ZipLimits) =>
  (await refusal(entries, limits)).code satisfies ZipErrorCode;

const bytesOf = async (file: File) => new Uint8Array(await file.arrayBuffer());

describe('the limits come from the page', () => {
  it('uses the picked-photo count and the per-photo size the page already has', () => {
    expect(PHOTO_ZIP_LIMITS.maxEntries).toBe(MAX_PICKED_PHOTOS);
    expect(PHOTO_ZIP_LIMITS.maxEntryBytes).toBe(PHOTO_MAX_INPUT_BYTES);
    expect(PHOTO_ZIP_LIMITS.maxZipBytes).toBe(MAX_ZIP_BYTES);
    expect(PHOTO_ZIP_LIMITS.maxTotalBytes).toBeGreaterThan(PHOTO_ZIP_LIMITS.maxZipBytes);
  });
});

describe('reading a ZIP of photos', () => {
  it('gives stored and deflated pictures back as files with their bytes and types', async () => {
    const files = await unzipPhotos(
      zipFile(
        buildZip([
          { name: 'a.jpg', data: JPEG(40), method: 8 },
          { name: 'b.png', data: PNG(), method: 0 },
          { name: 'c.webp', data: WEBP(), method: 8 },
        ]),
      ),
      LIMITS,
    );
    expect(files.map((file) => file.name)).toEqual(['a.jpg', 'b.png', 'c.webp']);
    expect(files.map((file) => file.type)).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(await bytesOf(files[0] as File)).toEqual(JPEG(40));
    expect(await bytesOf(files[1] as File)).toEqual(PNG());
  });

  it('flattens folders to base names, whichever slash was used', async () => {
    const files = await unzipPhotos(
      zipFile(
        buildZip([
          { name: 'shop/', data: new Uint8Array(), method: 0 },
          { name: 'shop/dates/dates-500g.jpg', data: JPEG() },
          { name: 'shop\\honey\\honey.PNG', data: PNG() },
          { name: '../../escape.webp', data: WEBP() },
        ]),
      ),
      LIMITS,
    );
    expect(files.map((file) => file.name)).toEqual(['dates-500g.jpg', 'honey.PNG', 'escape.webp']);
  });

  it('skips __MACOSX, dot-files and hidden folders, and they do not count toward the limits', async () => {
    const files = await unzipPhotos(
      zipFile(
        buildZip([
          { name: '__MACOSX/shop/._a.jpg', data: new Uint8Array([1, 2, 3]) },
          { name: 'shop/.DS_Store', data: new Uint8Array([1]) },
          { name: '.hidden/b.jpg', data: new Uint8Array([9]) },
          { name: 'shop/a.jpg', data: JPEG() },
        ]),
      ),
      { ...LIMITS, maxEntries: 1 },
    );
    expect(files.map((file) => file.name)).toEqual(['a.jpg']);
  });

  it('reads a ZIP with a comment and an empty ZIP', async () => {
    const files = await unzipPhotos(
      zipFile(buildZip([{ name: 'a.jpg', data: JPEG() }], { comment: 'made by hand' })),
      LIMITS,
    );
    expect(files).toHaveLength(1);
    expect(await unzipPhotos(zipFile(buildZip([])), LIMITS)).toEqual([]);
  });

  it('reads UTF-8 names (bit 11) and code page 437 names', async () => {
    const files = await unzipPhotos(
      zipFile(
        buildZip([
          { name: 'café-قهوة.jpg', data: JPEG() },
          {
            name: '',
            nameBytes: Uint8Array.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x6a, 0x70, 0x67]),
            utf8: false,
            data: JPEG(),
          },
        ]),
      ),
      LIMITS,
    );
    expect(files.map((file) => file.name)).toEqual(['café-قهوة.jpg', 'café.jpg']);
    expect(decodeEntryName(Uint8Array.from([0x80, 0xff, 0x41]), false)).toBe('Ç A');
  });
});

describe('refusing a ZIP', () => {
  it('refuses a ZIP over the size cap before reading it', async () => {
    const error = await refusal([{ name: 'a.jpg', data: JPEG() }], { ...LIMITS, maxZipBytes: 50 });
    expect(error.code).toBe('too-big');
  });

  it('refuses more kept entries than the limit', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.jpg`, data: JPEG() }));
    expect(await code(entries)).toBe('too-many-entries');
    expect(await unzipPhotos(zipFile(buildZip(entries.slice(0, 5))), LIMITS)).toHaveLength(5);
  });

  it('refuses a duplicate base name, without case, across folders', async () => {
    const error = await refusal([
      { name: 'one/Dates.jpg', data: JPEG() },
      { name: 'two/dates.JPG', data: JPEG(3) },
    ]);
    expect(error.code).toBe('duplicate-name');
    expect(error.entry).toBe('dates.JPG');
  });

  it('refuses an encrypted entry, and the AES method', async () => {
    expect(await code([{ name: 'a.jpg', data: JPEG(), flags: 0x0001 }])).toBe('encrypted');
    expect(await code([{ name: 'a.jpg', data: JPEG(), method: 99, compressed: JPEG() }])).toBe(
      'encrypted',
    );
  });

  it('refuses ZIP64 in the end record, the locator and the entry sizes', async () => {
    const error = await refusal([{ name: 'a.jpg', data: JPEG() }], LIMITS, { zip64Locator: true });
    expect(error.code).toBe('zip64');
    expect(
      (await refusal([{ name: 'a.jpg', data: JPEG() }], LIMITS, { totalOverride: 0xffff })).code,
    ).toBe('zip64');
    expect(await code([{ name: 'a.jpg', data: JPEG(), declaredSize: 0xffffffff }])).toBe('zip64');
  });

  it('refuses a method other than stored and deflate', async () => {
    const error = await refusal([{ name: 'a.jpg', data: JPEG(), method: 12, compressed: JPEG() }]);
    expect(error.code).toBe('unsupported-compression');
  });

  it('refuses a multi-disk archive', async () => {
    const error = await refusal([{ name: 'a.jpg', data: JPEG() }], LIMITS, { disk: 1 });
    expect(error.code).toBe('multi-disk');
  });

  it('refuses a broken or truncated archive', async () => {
    const whole = buildZip([{ name: 'a.jpg', data: JPEG(60) }]);
    for (const bytes of [
      whole.subarray(0, whole.length - 10),
      whole.subarray(0, 10),
      new Uint8Array(100),
      new TextEncoder().encode('this is not a zip file at all, only some text'),
    ]) {
      await expect(unzipPhotos(zipFile(bytes), LIMITS)).rejects.toMatchObject({ code: 'broken' });
    }
  });

  it('refuses entries whose data is damaged or whose header points outside the file', async () => {
    const good = buildZip([{ name: 'a.jpg', data: JPEG(60), method: 0 }]);
    const damaged = Uint8Array.from(good);
    damaged.fill(0xaa, 45, 46); // a content byte: the checksum no longer matches
    await expect(unzipPhotos(zipFile(damaged), LIMITS)).rejects.toMatchObject({ code: 'broken' });
    expect(await code([{ name: 'a.jpg', data: JPEG(), localOffset: 5000 }])).toBe('broken');
    expect(
      await code([
        {
          name: 'a.jpg',
          data: JPEG(),
          method: 8,
          compressed: Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
        },
      ]),
    ).toBe('broken');
  });

  it('refuses an entry declared over the per-entry cap, before inflating it', async () => {
    const error = await refusal([{ name: 'big.jpg', data: JPEG(), declaredSize: 5000 }]);
    expect(error.code).toBe('entry-too-big');
    expect(error.entry).toBe('big.jpg');
  });

  it('stops inflating when the real size goes over the cap although the header lies', async () => {
    const bomb = new Uint8Array(2_000_000);
    bomb.set([0xff, 0xd8, 0xff]);
    const error = await refusal([{ name: 'bomb.jpg', data: bomb, declaredSize: 20 }]);
    expect(error.code).toBe('entry-too-big');
    expect(error.entry).toBe('bomb.jpg');
  });

  it('refuses when the entries together are over the total cap, declared or real', async () => {
    const three = ['a', 'b', 'c', 'd'].map((n) => ({
      name: `${n}.jpg`,
      data: JPEG(),
      declaredSize: 900,
    }));
    expect(await code(three)).toBe('total-too-big');
    const big = new Uint8Array(900);
    big.set([0xff, 0xd8, 0xff]);
    const lying = [
      { name: 'a.jpg', data: big },
      { name: 'b.jpg', data: big },
      { name: 'c.jpg', data: big, declaredSize: 10 },
    ];
    expect(await code(lying, { ...LIMITS, maxTotalBytes: 2000 })).toBe('total-too-big');
  });

  it('refuses a name that is not a picture, and content that is not a picture', async () => {
    const byName = await refusal([
      { name: 'a.jpg', data: JPEG() },
      { name: 'notes/readme.txt', data: new TextEncoder().encode('hi') },
    ]);
    expect(byName.code).toBe('not-image');
    expect(byName.entry).toBe('readme.txt');
    const byContent = await refusal([
      { name: 'fake.jpg', data: new TextEncoder().encode('<html>') },
    ]);
    expect(byContent.code).toBe('not-image');
    expect(byContent.entry).toBe('fake.jpg');
  });
});

describe('sniffImage', () => {
  it('knows JPEG, PNG and WebP by their first bytes only', () => {
    expect(sniffImage(JPEG())).toBe('image/jpeg');
    expect(sniffImage(PNG())).toBe('image/png');
    expect(sniffImage(WEBP())).toBe('image/webp');
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});
