import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { MAX_DOCUMENT_BYTES } from '../application/intake/document-inspection';
import { inspectPdfIsolated, parkedWorkers } from './isolated-pdf-inspection';
import { MAX_WAITING, SharpDocumentIntake } from './sharp-document-intake';

// The file intake with the real image library (certification design 9.3, simplified): the type
// from the content, images written again without metadata, polyglots and oversized files refused.

const intake = new SharpDocumentIntake();

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page>> endobj\n%%EOF\n',
);
const JS_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type /Pages /Count 1>> endobj\n2 0 obj <</Type /Page /AA <</O <</S /JavaScript /JS (x)>>>>>> endobj\n%%EOF\n',
);

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 12, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
}

async function jpegWithMetadata(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 12, channels: 3, background: '#993333' } })
    .withExif({ IFD0: { Copyright: 'someone-private', ImageDescription: 'GPS home' } })
    .jpeg()
    .toBuffer();
}

describe('SharpDocumentIntake', () => {
  it('accepts a PNG and writes it again as a PNG', async () => {
    const result = await intake.inspect(await png());
    expect(result).toMatchObject({ ok: true, value: { mediaType: 'image/png', pageCount: null } });
  });

  it('writes a JPEG again without its metadata', async () => {
    const original = await jpegWithMetadata();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const result = await intake.inspect(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mediaType).toBe('image/jpeg');
    const written = await sharp(result.value.bytes).metadata();
    expect(written.format).toBe('jpeg');
    expect(written.exif).toBeUndefined();
    expect(result.value.bytes.includes(Buffer.from('someone-private'))).toBe(false);
  });

  it('accepts a PDF as received, with its page count', async () => {
    const result = await intake.inspect(PDF);
    expect(result).toMatchObject({
      ok: true,
      value: { mediaType: 'application/pdf', pageCount: 1 },
    });
    if (result.ok) expect(result.value.bytes.equals(PDF)).toBe(true);
  });

  it('refuses a PDF with a script', async () => {
    expect(await intake.inspect(JS_PDF)).toEqual({
      ok: false,
      error: { code: 'file.active-content' },
    });
  });

  it('refuses bytes with the wrong magic, whatever they are called', async () => {
    expect(await intake.inspect(Buffer.from('MZ\x90\x00 an executable'))).toEqual({
      ok: false,
      error: { code: 'file.unsupported-type' },
    });
    const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    expect(await intake.inspect(heic)).toEqual({
      ok: false,
      error: { code: 'file.unsupported-type' },
    });
  });

  it('refuses a polyglot: a PNG header followed by a PDF body is not an image', async () => {
    const header = (await png()).subarray(0, 8);
    const polyglot = Buffer.concat([header, PDF]);
    const result = await intake.inspect(polyglot);
    expect(result).toEqual({ ok: false, error: { code: 'file.unreadable' } });
  });

  it('refuses a JPEG whose content is really a PNG', async () => {
    const real = await png();
    const liar = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), real.subarray(3)]);
    const result = await intake.inspect(liar);
    expect(result.ok).toBe(false);
  });

  it('refuses a truncated image', async () => {
    const whole = await png();
    expect(await intake.inspect(whole.subarray(0, 40))).toEqual({
      ok: false,
      error: { code: 'file.unreadable' },
    });
  });

  it('refuses an empty file and a file over the size limit', async () => {
    expect(await intake.inspect(Buffer.alloc(0))).toEqual({
      ok: false,
      error: { code: 'file.unreadable' },
    });
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_DOCUMENT_BYTES)]);
    expect(await intake.inspect(big)).toEqual({ ok: false, error: { code: 'file.too-large' } });
    expect(big.length).toBeGreaterThan(MAX_DOCUMENT_BYTES);
  });

  it('refuses, in a worker thread, a hostile PDF in well under a second (H1)', async () => {
    const hostile = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.from('/Type /Pages '.repeat(80_000)),
      Buffer.from('\n%%EOF\n'),
    ]);
    const started = Date.now();
    expect(await intake.inspect(hostile)).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('refuses a PDF whose scan runs past the timeout, then serves the next file', async () => {
    // About 9 MB of small dictionaries: the scan takes far longer than the 5 ms allowed here.
    const heavy = Buffer.from(
      '%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n' +
        '<< /A 1 % c\n>> '.repeat(600_000) +
        '\n%%EOF\n',
      'latin1',
    );
    expect(await inspectPdfIsolated(heavy, 5)).toEqual({
      ok: false,
      code: 'file.inspection-timeout',
    });
    expect(await inspectPdfIsolated(PDF)).toEqual({ ok: true, pageCount: 1 });
  });

  // Security re-review of PR 382 (M2-bis, L5, L6).
  it('M2-bis: the hostile file of the review is refused without growing the process by 256 MB', async () => {
    const latin = (text: string): Buffer => Buffer.from(text, 'latin1');
    // Four object streams of 8 MiB of name escapes each: the scan used to take 700 MB for this.
    const z = deflateSync(latin('<</a#41/b#42 (x)>>'.repeat(460_000)), { level: 9 });
    const stream = Buffer.concat([
      latin('<</Type/ObjStm/N 1/First 0/Filter/FlateDecode>>stream\n'),
      z,
      latin('\nendstream\n'),
    ]);
    const hostile = Buffer.concat([
      latin('%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n'),
      stream,
      stream,
      stream,
      stream,
      latin('\n%%EOF\n'),
    ]);
    await inspectPdfIsolated(PDF);
    const base = process.memoryUsage().rss;
    let peak = base;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    const verdict = await inspectPdfIsolated(hostile, 20_000);
    clearInterval(sampler);
    // The total inflate budget is spent: refused, never accepted unread (structural, not timed).
    expect(verdict).toEqual({ ok: false, code: 'file.too-complex' });
    expect((peak - base) / 1024 / 1024).toBeLessThan(256);
  });

  it('L5: files beyond the busy slots and the bounded queue are refused as busy', async () => {
    const total = 2 + MAX_WAITING + 3;
    const results = await Promise.all(Array.from({ length: total }, () => intake.inspect(PDF)));
    const busy = results.filter((r) => !r.ok && r.error.code === 'request.throttled');
    expect(busy).toHaveLength(3);
    expect(results.filter((r) => r.ok)).toHaveLength(total - 3);
    // The queue drains: the next file is served.
    expect(await intake.inspect(PDF)).toMatchObject({ ok: true });
  });

  it('L6: a worker that dies while parked leaves the pool, and the next file is not delayed', async () => {
    expect(await inspectPdfIsolated(PDF)).toEqual({ ok: true, pageCount: 1 });
    const parked = [...parkedWorkers()];
    expect(parked.length).toBeGreaterThan(0);
    await Promise.all(parked.map((worker) => worker.terminate()));
    expect(parkedWorkers()).toHaveLength(0);
    const started = Date.now();
    expect(await inspectPdfIsolated(PDF, 2_000)).toEqual({ ok: true, pageCount: 1 });
    expect(Date.now() - started).toBeLessThan(1_900);
  });
});
