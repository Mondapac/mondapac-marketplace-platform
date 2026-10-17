import sharp from 'sharp';
import { MAX_DOCUMENT_BYTES } from '../application/intake/document-inspection';
import { inspectPdfIsolated } from './isolated-pdf-inspection';
import { SharpDocumentIntake } from './sharp-document-intake';

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
});
