import { deflateSync } from 'node:zlib';
import { detectMediaType, inspectPdf, MAX_PDF_PAGES } from './document-inspection';

// The byte checks of the certificate file intake (certification design 9.3, simplified): the type
// from the first bytes only, and the PDF scan for encryption, active content and pages.

const pdfOf = (body: string, pages = 1): Buffer =>
  Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
      `2 0 obj <</Type /Pages /Kids [3 0 R] /Count ${pages}>> endobj`,
      ...Array.from(
        { length: pages },
        (_, index) => `${3 + index} 0 obj <</Type /Page /Parent 2 0 R>> endobj`,
      ),
      body,
      'trailer <</Root 1 0 R>>',
      '%%EOF',
      '',
    ].join('\n'),
    'latin1',
  );

describe('detectMediaType', () => {
  it('reads JPEG, PNG and PDF from the first bytes', () => {
    expect(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(
      detectMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('image/png');
    expect(detectMediaType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('knows nothing else: text, HEIC and an empty file have no type', () => {
    expect(detectMediaType(Buffer.from('hello'))).toBeNull();
    const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]);
    expect(detectMediaType(heic)).toBeNull();
    expect(detectMediaType(Buffer.alloc(0))).toBeNull();
  });

  it('does not take a name or a declared type, only bytes: a PDF named .png is still a PDF', () => {
    expect(detectMediaType(Buffer.from('%PDF-1.4 renamed.png'))).toBe('application/pdf');
  });
});

describe('inspectPdf', () => {
  it('accepts a plain PDF and counts its pages', () => {
    expect(inspectPdf(pdfOf('', 1))).toEqual({ ok: true, pageCount: 1 });
    expect(inspectPdf(pdfOf('', 7))).toEqual({ ok: true, pageCount: 7 });
  });

  it('refuses a file that does not start with %PDF-', () => {
    expect(inspectPdf(Buffer.from('GIF89a%PDF-1.4\n%%EOF'))).toEqual({
      ok: false,
      code: 'file.unsupported-type',
    });
  });

  it('refuses a truncated file (no %%EOF near its end)', () => {
    expect(inspectPdf(Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n'))).toEqual({
      ok: false,
      code: 'file.unreadable',
    });
  });

  it('refuses an encrypted PDF', () => {
    expect(inspectPdf(pdfOf('/Encrypt 9 0 R'))).toEqual({ ok: false, code: 'file.encrypted' });
  });

  it.each([
    ['JavaScript', '/S /JavaScript /JS (app.alert(1))'],
    ['JS alone', '<</JS (x)>>'],
    ['Launch', '<</S /Launch /F (cmd.exe)>>'],
    ['OpenAction', '/OpenAction 4 0 R'],
    ['AA', '/AA <</O 4 0 R>>'],
    ['EmbeddedFile', '/Type /EmbeddedFile'],
    ['RichMedia', '/Subtype /RichMedia'],
    ['XFA', '/XFA [(a) 5 0 R]'],
    ['a name hidden with a hex escape', '/Java#53cript'],
  ])('refuses active content: %s', (_label, body) => {
    expect(inspectPdf(pdfOf(body))).toEqual({ ok: false, code: 'file.active-content' });
  });

  it('does not take a longer name for an active one (/JSON is not /JS)', () => {
    expect(inspectPdf(pdfOf('/JSON 1 /AAA 2 /OpenActions 3'))).toMatchObject({ ok: true });
  });

  it('reads inside a compressed object stream, where an action can hide', () => {
    const inner = deflateSync(Buffer.from('<</S /JavaScript /JS (evil)>>', 'latin1'));
    const stream = Buffer.concat([
      Buffer.from(
        '%PDF-1.5\n5 0 obj <</Type /ObjStm /N 1 /First 4 /Filter /FlateDecode>>\nstream\n',
      ),
      inner,
      Buffer.from(
        '\nendstream endobj\n3 0 obj <</Type /Page>> endobj\n2 0 obj <</Type /Pages /Count 1>> endobj\n%%EOF\n',
      ),
    ]);
    expect(inspectPdf(stream)).toEqual({ ok: false, code: 'file.active-content' });
  });

  it('refuses an object stream that does not inflate', () => {
    const stream = Buffer.concat([
      Buffer.from('%PDF-1.5\n5 0 obj <</Type /ObjStm /N 1 /First 4>>\nstream\n'),
      Buffer.from('not a deflate stream'),
      Buffer.from('\nendstream endobj\n3 0 obj <</Type /Page>> endobj\n%%EOF\n'),
    ]);
    expect(inspectPdf(stream)).toEqual({ ok: false, code: 'file.unreadable' });
  });

  it('refuses a PDF with no page', () => {
    expect(inspectPdf(Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n'))).toEqual({
      ok: false,
      code: 'file.unreadable',
    });
  });

  it(`refuses more than ${MAX_PDF_PAGES} pages, and accepts exactly ${MAX_PDF_PAGES}`, () => {
    expect(inspectPdf(pdfOf('', MAX_PDF_PAGES))).toEqual({ ok: true, pageCount: MAX_PDF_PAGES });
    expect(inspectPdf(pdfOf('', MAX_PDF_PAGES + 1))).toEqual({
      ok: false,
      code: 'file.too-many-pages',
    });
  });

  it('refuses a page tree that declares more pages than the limit, whatever it lists', () => {
    const lying = Buffer.from(
      '%PDF-1.4\n2 0 obj <</Type /Pages /Count 5000>> endobj\n3 0 obj <</Type /Page>> endobj\n%%EOF\n',
    );
    expect(inspectPdf(lying)).toEqual({ ok: false, code: 'file.too-many-pages' });
  });
});
