import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHOTO_MAX_INPUT_BYTES } from '../photo-limits.ts';
import { MAX_PICKED_PHOTOS } from './photo-queue.ts';
import {
  MAX_ZIP_BYTES,
  MAX_ZIP_TOTAL_BYTES,
  PHOTO_ZIP_LIMITS,
  sniffImage,
  unzipPhotos,
} from './photo-zip.ts';
import { buildZip, JPEG, PNG, WEBP, zipFile, type FixtureEntry } from './zip-fixture.ts';
import { decodeEntryName, ZipCancelled, ZipError, type ZipLimits } from './zip-reader.ts';

const LIMITS: ZipLimits = {
  maxZipBytes: 100_000,
  maxEntries: 5,
  maxEntryBytes: 1000,
  maxTotalBytes: 3000,
};

const read = (bytes: Uint8Array, limits: ZipLimits = LIMITS) =>
  unzipPhotos(zipFile(bytes), { limits });

async function refusal(
  entries: readonly FixtureEntry[],
  limits: ZipLimits = LIMITS,
  options?: Parameters<typeof buildZip>[1],
): Promise<ZipError> {
  try {
    await read(buildZip(entries, options), limits);
  } catch (error) {
    if (error instanceof ZipError) return error;
    throw error;
  }
  throw new Error('the ZIP was accepted');
}

const code = async (entries: readonly FixtureEntry[], limits?: ZipLimits) =>
  (await refusal(entries, limits)).code;

const bytesOf = async (file: File) => new Uint8Array(await file.arrayBuffer());
const names = (files: readonly File[]) => files.map((file) => file.name);

afterEach(() => vi.unstubAllGlobals());

describe('the limits come from the page', () => {
  it('uses the picked-photo count and the per-photo size the page already has', () => {
    expect(PHOTO_ZIP_LIMITS.maxEntries).toBe(MAX_PICKED_PHOTOS);
    expect(PHOTO_ZIP_LIMITS.maxEntryBytes).toBe(PHOTO_MAX_INPUT_BYTES);
    expect(PHOTO_ZIP_LIMITS.maxZipBytes).toBe(MAX_ZIP_BYTES);
    expect(MAX_ZIP_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_ZIP_TOTAL_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe('reading a ZIP of photos', () => {
  it('gives stored and deflated pictures back as files with their bytes and types', async () => {
    const { files, notImage, tooBig } = await read(
      buildZip([
        { name: 'a.jpg', data: JPEG(40), method: 8 },
        { name: 'b.png', data: PNG(), method: 0 },
        { name: 'c.webp', data: WEBP(), method: 8 },
      ]),
    );
    expect(names(files)).toEqual(['a.jpg', 'b.png', 'c.webp']);
    expect(files.map((file) => file.type)).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(await bytesOf(files[0] as File)).toEqual(JPEG(40));
    expect(await bytesOf(files[1] as File)).toEqual(PNG());
    expect(notImage + tooBig).toBe(0);
  });

  it('flattens folders to base names, whichever slash was used', async () => {
    const { files } = await read(
      buildZip([
        { name: 'shop/', data: new Uint8Array(), method: 0 },
        { name: 'shop/dates/dates-500g.jpg', data: JPEG() },
        { name: 'shop\\honey\\honey.PNG', data: PNG() },
        { name: '../../escape.webp', data: WEBP() },
      ]),
    );
    expect(names(files)).toEqual(['dates-500g.jpg', 'honey.PNG', 'escape.webp']);
  });

  it('skips __MACOSX, dot-files and hidden folders, and they do not count toward the limits', async () => {
    const { files, notImage } = await read(
      buildZip([
        { name: '__MACOSX/shop/._a.jpg', data: new Uint8Array([1, 2, 3]) },
        { name: 'shop/.DS_Store', data: new Uint8Array([1]) },
        { name: '.hidden/b.jpg', data: new Uint8Array([9]) },
        { name: 'shop/a.jpg', data: JPEG() },
      ]),
      { ...LIMITS, maxEntries: 1 },
    );
    expect(names(files)).toEqual(['a.jpg']);
    expect(notImage).toBe(0);
  });

  it('reads a ZIP with a comment and an empty ZIP', async () => {
    const { files } = await read(
      buildZip([{ name: 'a.jpg', data: JPEG() }], { comment: 'made by hand' }),
    );
    expect(files).toHaveLength(1);
    expect((await read(buildZip([]))).files).toEqual([]);
  });

  it('reads UTF-8 names (bit 11) and code page 437 names', async () => {
    const { files } = await read(
      buildZip([
        { name: 'café-قهوة.jpg', data: JPEG() },
        {
          name: '',
          nameBytes: Uint8Array.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x6a, 0x70, 0x67]),
          utf8: false,
          data: JPEG(),
        },
      ]),
    );
    expect(names(files)).toEqual(['café-قهوة.jpg', 'café.jpg']);
    expect(decodeEntryName(Uint8Array.from([0x80, 0xff, 0x41]), false)).toBe('Ç A');
  });

  it('puts names in NFC, so e + accent and the single letter are one name', async () => {
    const error = await refusal([
      { name: 'café.jpg', data: JPEG() },
      { name: 'café.jpg', data: JPEG(3) },
    ]);
    expect(error.code).toBe('duplicate-name');
  });
});

describe('leaving entries out', () => {
  it('skips and counts entries that are not pictures, by name and by content', async () => {
    const { files, notImage, tooBig } = await read(
      buildZip([
        { name: 'a.jpg', data: JPEG() },
        { name: 'Thumbs.db', data: new Uint8Array([1, 2]) },
        { name: 'notes/list.csv', data: new TextEncoder().encode('a,b') },
        { name: 'fake.png', data: new TextEncoder().encode('<html>') },
      ]),
    );
    expect(names(files)).toEqual(['a.jpg']);
    expect(notImage).toBe(3);
    expect(tooBig).toBe(0);
  });

  it('skips and counts an entry honestly declared over the per-photo cap, without reading it', async () => {
    const { files, tooBig } = await read(
      buildZip([
        { name: 'a.jpg', data: JPEG() },
        { name: 'huge.jpg', data: JPEG(), declaredSize: 5000 },
      ]),
    );
    expect(names(files)).toEqual(['a.jpg']);
    expect(tooBig).toBe(1);
  });

  it('does not count skipped entries toward the entry or total limits', async () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.jpg`, data: JPEG() })),
      { name: 'x.jpg', data: JPEG(), declaredSize: 9999 },
      { name: 'x.csv', data: new Uint8Array([1]) },
    ];
    const { files, tooBig, notImage } = await read(buildZip(entries));
    expect(files).toHaveLength(5);
    expect([tooBig, notImage]).toEqual([1, 1]);
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
    expect((await read(buildZip(entries.slice(0, 5)))).files).toHaveLength(5);
  });

  it('refuses a directory larger than the records it may hold', async () => {
    const bytes = Uint8Array.from(buildZip([{ name: 'a.jpg', data: JPEG() }]));
    new DataView(bytes.buffer).setUint32(bytes.length - 22 + 12, 100_000_000, true);
    await expect(read(bytes)).rejects.toMatchObject({ code: 'too-many-entries' });
  });

  it('refuses a duplicate base name, without case, across folders', async () => {
    const error = await refusal([
      { name: 'one/Dates.jpg', data: JPEG() },
      { name: 'two/dates.JPG', data: JPEG(3) },
    ]);
    expect(error.code).toBe('duplicate-name');
    expect(error.entry).toBe('dates.JPG');
  });

  it('refuses names with C1 controls or bidi overrides', async () => {
    expect(await code([{ name: 'a\u0085b.jpg', data: JPEG() }])).toBe('broken');
    expect(await code([{ name: 'a‮gpj.exe.jpg', data: JPEG() }])).toBe('broken');
  });

  it('refuses an encrypted entry, and the AES method', async () => {
    expect(await code([{ name: 'a.jpg', data: JPEG(), flags: 0x0001 }])).toBe('encrypted');
    expect(await code([{ name: 'a.jpg', data: JPEG(), method: 99, compressed: JPEG() }])).toBe(
      'encrypted',
    );
  });

  it('refuses ZIP64 in the end record, the locator and the entry sizes', async () => {
    const one = [{ name: 'a.jpg', data: JPEG() }];
    expect((await refusal(one, LIMITS, { zip64Locator: true })).code).toBe('zip64');
    expect((await refusal(one, LIMITS, { totalOverride: 0xffff })).code).toBe('zip64');
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
      await expect(read(bytes)).rejects.toMatchObject({ code: 'broken' });
    }
  });

  it('does not take an end record that is only text inside the comment', async () => {
    // 'PK\x05\x06' and 18 zero bytes: a whole fake end record at the very end of the file.
    const fake = `PK\u0005\u0006${'\u0000'.repeat(18)}`;
    const error = await refusal([{ name: 'a.jpg', data: JPEG() }], LIMITS, { comment: fake });
    expect(error.code).toBe('broken');
  });

  it('refuses entries whose data is damaged or whose header points outside the file', async () => {
    const good = buildZip([{ name: 'a.jpg', data: JPEG(60), method: 0 }]);
    const damaged = Uint8Array.from(good);
    damaged.fill(0xaa, 45, 46);
    await expect(read(damaged)).rejects.toMatchObject({ code: 'broken' });
    expect(await code([{ name: 'a.jpg', data: JPEG(), localOffset: 5000 }])).toBe('broken');
    expect(
      await code([
        { name: 'a.jpg', data: JPEG(), compressed: Uint8Array.from([0xff, 0xff, 0xff, 0xff]) },
      ]),
    ).toBe('broken');
  });

  it('refuses entries that overlap, or whose data reaches into the directory', async () => {
    // a.jpg claims 400 stored bytes: its data runs over the next entry.
    const overlap = await refusal([
      { name: 'a.jpg', data: JPEG(), method: 0, declaredSize: 400, declaredCompressedSize: 400 },
      { name: 'b.jpg', data: JPEG(600), method: 0 },
    ]);
    expect(overlap.code).toBe('broken');
    // The last entry claims more data than is left before the directory.
    const intoDirectory = await refusal([
      { name: 'a.jpg', data: JPEG(), method: 0, declaredSize: 400, declaredCompressedSize: 400 },
    ]);
    expect(intoDirectory.code).toBe('broken');
  });

  it('refuses a local header that disagrees with the directory', async () => {
    const other = new TextEncoder().encode('b.jpg');
    expect(await code([{ name: 'a.jpg', data: JPEG(), localNameBytes: other }])).toBe('broken');
    expect(await code([{ name: 'a.jpg', data: JPEG(), method: 8, localMethod: 0 }])).toBe('broken');
  });

  it('refuses a header that lies about the size, in either direction, and stops inflating', async () => {
    const bomb = new Uint8Array(2_000_000);
    bomb.set([0xff, 0xd8, 0xff]);
    const small = await refusal([{ name: 'bomb.jpg', data: bomb, declaredSize: 20 }]);
    expect(small.code).toBe('broken');
    // Declared larger than the real size (still inside the cap).
    expect(await code([{ name: 'a.jpg', data: JPEG(), declaredSize: 900 }])).toBe('broken');
  });

  it('refuses when the entries together are over the total cap, declared or real', async () => {
    const four = ['a', 'b', 'c', 'd'].map((n) => ({
      name: `${n}.jpg`,
      data: JPEG(),
      declaredSize: 900,
    }));
    expect(await code(four)).toBe('total-too-big');
  });

  it('refuses a deflate entry when this browser has no DecompressionStream', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    expect(await code([{ name: 'a.jpg', data: JPEG(), method: 8 }])).toBe('unsupported-browser');
    // A stored entry needs none.
    expect((await read(buildZip([{ name: 'a.jpg', data: JPEG(), method: 0 }]))).files).toHaveLength(
      1,
    );
  });

  it('stops with ZipCancelled when the signal is aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      unzipPhotos(zipFile(buildZip([{ name: 'a.jpg', data: JPEG() }])), {
        limits: LIMITS,
        signal: abort.signal,
      }),
    ).rejects.toBeInstanceOf(ZipCancelled);
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
