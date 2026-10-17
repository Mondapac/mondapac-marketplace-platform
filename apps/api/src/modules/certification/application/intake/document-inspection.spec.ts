import { deflateSync } from 'node:zlib';
import {
  detectMediaType,
  inspectPdf,
  MAX_OBJECT_STREAMS,
  MAX_PDF_PAGES,
} from './document-inspection';

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
      Buffer.from(
        '%PDF-1.5\n5 0 obj <</Type /ObjStm /N 1 /First 4 /Filter /FlateDecode>>\nstream\n',
      ),
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

// Security review of PR 382 (H1, M1, M2): the scan is linear, and it refuses what it cannot read.
describe('inspectPdf under attack', () => {
  const latin = (text: string): Buffer => Buffer.from(text, 'latin1');
  const tail = latin('\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
  const pages = latin(
    '%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page >> endobj\n',
  );
  const script = '<< /S /JavaScript /JS (app.alert(1)) >>';
  function objectStream(content: string | Buffer, options: { pad?: string; type?: string } = {}) {
    const z = deflateSync(typeof content === 'string' ? latin(content) : content, { level: 9 });
    return Buffer.concat([
      latin(
        `9 0 obj << /Type ${options.type ?? '/ObjStm'} ${options.pad ?? ''}/N 1 /First 0 ` +
          `/Filter /FlateDecode /Length ${z.length} >>\nstream\n`,
      ),
      z,
      latin('\nendstream\nendobj\n'),
    ]);
  }
  const pdfWith = (...parts: Buffer[]): Buffer => Buffer.concat([pages, ...parts, tail]);

  it('control: a script in one compressed object stream is refused', () => {
    expect(inspectPdf(pdfWith(objectStream(script)))).toEqual({
      ok: false,
      code: 'file.active-content',
    });
  });

  it('M1a: refuses more object streams than it scans, instead of accepting the rest unread', () => {
    const benign = Array.from({ length: MAX_OBJECT_STREAMS }, () => objectStream('<< /Foo 1 >>'));
    expect(inspectPdf(pdfWith(...benign))).toMatchObject({ ok: true });
    expect(inspectPdf(pdfWith(...benign, objectStream(script)))).toEqual({
      ok: false,
      code: 'file.too-complex',
    });
  });

  it('M1b: finds the object stream whatever the size of its padded dictionary', () => {
    const padded = objectStream(script, { pad: `/Pad (${'x'.repeat(5000)}) ` });
    expect(inspectPdf(pdfWith(padded))).toEqual({ ok: false, code: 'file.active-content' });
  });

  it('M1b: a dictionary that does not close within the bound is refused, not skipped', () => {
    const open = latin(`9 0 obj << /Type /ObjStm /Pad (${'x'.repeat(300_000)}) >>\nstream\n`);
    expect(inspectPdf(pdfWith(open))).toEqual({ ok: false, code: 'file.too-complex' });
    expect(inspectPdf(pdfWith(latin('9 0 obj << /Type /ObjStm /Pad (never closed')))).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it('M1c: reads a name written with escapes (/Obj#53tm, /#4aavaScript)', () => {
    expect(inspectPdf(pdfWith(objectStream(script, { type: '/Obj#53tm' })))).toEqual({
      ok: false,
      code: 'file.active-content',
    });
    expect(inspectPdf(pdfWith(objectStream('<< /S /#4aavaScript >>')))).toEqual({
      ok: false,
      code: 'file.active-content',
    });
  });

  it('M2: refuses object streams that inflate past the total budget (decompression bomb)', () => {
    const bomb = deflateSync(Buffer.alloc(8 * 1024 * 1024 - 16, 0x20), { level: 9 });
    const one = Buffer.concat([
      latin('9 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\n'),
      bomb,
      latin('\nendstream\nendobj\n'),
    ]);
    const started = Date.now();
    const verdict = inspectPdf(pdfWith(...Array.from({ length: 8 }, () => one)));
    expect(verdict).toEqual({ ok: false, code: 'file.too-complex' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('H1: a 1 MiB file of repeated /Type /Pages is answered in linear time', () => {
    const hostile = Buffer.concat([
      latin('%PDF-1.7\n'),
      latin('/Type /Pages '.repeat(80_000)),
      tail,
    ]);
    const control = Buffer.concat([
      latin('%PDF-1.7\n'),
      latin('/Type /Pagex '.repeat(80_000)),
      tail,
    ]);
    const time = (bytes: Buffer): number => {
      const started = process.hrtime.bigint();
      inspectPdf(bytes);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    time(control);
    const baseline = Math.max(time(control), 20);
    // Before the fix this took 26 s; a generous multiple of the control keeps the test stable.
    expect(time(hostile)).toBeLessThan(baseline * 25 + 500);
  });

  it('H1: many short dictionaries and comments stay linear (four times the input, not sixteen)', () => {
    const timeOf = (count: number): number => {
      const body = latin('<< /A 1 % c\n>> '.repeat(count));
      const started = process.hrtime.bigint();
      expect(inspectPdf(pdfWith(body))).toMatchObject({ ok: true });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    timeOf(10_000);
    const small = Math.max(timeOf(40_000), 10);
    // Quadratic growth would cost 16 times; the bound leaves room for a loaded machine.
    expect(timeOf(160_000)).toBeLessThan(small * 12 + 500);
  });

  // Security re-review of PR 382 (M1-bis): six ways past the scan, each a regression test.
  describe('M1-bis: the scan reads what a viewer reads', () => {
    const rawStream = (dictionary: string, data: Buffer, gap = ''): Buffer =>
      Buffer.concat([
        latin(`9 0 obj ${dictionary}${gap}\nstream\n`),
        data,
        latin('\nendstream\nendobj\n'),
      ]);
    const refusedAs = (code: string) => ({ ok: false, code });

    it('1: refuses a Flate filter chain [/FlateDecode /FlateDecode] holding a script', () => {
      const z = deflateSync(deflateSync(latin(script)));
      const dictionary = `<< /Type /ObjStm /N 1 /First 0 /Filter [/FlateDecode /FlateDecode] /Length ${z.length} >>`;
      expect(inspectPdf(pdfWith(rawStream(dictionary, z)))).toEqual(refusedAs('file.too-complex'));
    });

    it('2: refuses [/FlateDecode /ASCIIHexDecode] holding a script in hex', () => {
      const z = deflateSync(latin(Buffer.from(script).toString('hex') + '>'));
      const dictionary = `<< /N 1 /First 0 /Filter [/FlateDecode /ASCIIHexDecode] /Length ${z.length} >>`;
      expect(inspectPdf(pdfWith(rawStream(dictionary, z)))).toEqual(refusedAs('file.too-complex'));
    });

    it('2: refuses another filter or a predictor on a stream that could be an object stream', () => {
      const z = deflateSync(latin(script));
      for (const extra of [
        '/Filter /LZWDecode',
        '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>',
        '/Filter /FlateDecode /DP << /Predictor 12 >>',
        '/Filter 7 0 R',
        '/Filter /Fl',
      ]) {
        const dictionary = `<< /N 1 /First 0 ${extra} >>`;
        expect(inspectPdf(pdfWith(rawStream(dictionary, z)))).toEqual(
          refusedAs('file.too-complex'),
        );
      }
    });

    it('3: a NUL ends a name: /JS, /OpenAction and /Encrypt are found before it', () => {
      expect(inspectPdf(pdfWith(latin('<< /S /JavaScript\x00/JS\x00(x) >>')))).toEqual(
        refusedAs('file.active-content'),
      );
      expect(inspectPdf(pdfWith(latin('/OpenAction\x004 0 R')))).toEqual(
        refusedAs('file.active-content'),
      );
      expect(inspectPdf(pdfWith(latin('trailer << /Encrypt\x006 0 R >>')))).toEqual(
        refusedAs('file.encrypted'),
      );
    });

    it('3: every white space and delimiter ends a name', () => {
      for (const end of [
        '\t',
        '\n',
        '\f',
        '\r',
        ' ',
        '(',
        ')',
        '<',
        '>',
        '[',
        ']',
        '{',
        '}',
        '/',
        '%',
      ]) {
        expect(inspectPdf(pdfWith(latin(`/JS${end}`)))).toEqual(refusedAs('file.active-content'));
      }
    });

    it('4: reads an object stream that does not say /Type /ObjStm', () => {
      const z = deflateSync(latin(script));
      const dictionary = `<< /N 1 /First 0 /Filter /FlateDecode /Length ${z.length} >>`;
      expect(inspectPdf(pdfWith(rawStream(dictionary, z)))).toEqual(
        refusedAs('file.active-content'),
      );
      expect(inspectPdf(pdfWith(objectStream(script, { type: '/Foo' })))).toEqual(
        refusedAs('file.active-content'),
      );
    });

    it('4: pages hidden in an object stream without a /Type count toward the limit', () => {
      const many = Array.from({ length: MAX_PDF_PAGES + 1 }, () => '<< /Type /Page >>').join(' ');
      const z = deflateSync(latin(many));
      const dictionary = `<< /N 1 /First 0 /Filter /FlateDecode /Length ${z.length} >>`;
      expect(inspectPdf(pdfWith(rawStream(dictionary, z)))).toEqual(
        refusedAs('file.too-many-pages'),
      );
    });

    it('5: refuses an indirect /Type (/Type 8 0 R), whatever it hides', () => {
      expect(inspectPdf(pdfWith(objectStream(script, { type: '8 0 R' })))).toEqual(
        refusedAs('file.too-complex'),
      );
      expect(inspectPdf(pdfWith(latin('10 0 obj << /Type 8 0 R >> endobj')))).toEqual(
        refusedAs('file.too-complex'),
      );
    });

    it('5: refuses a page tree whose /Count is not written directly', () => {
      const tree = latin(
        '%PDF-1.4\n2 0 obj <</Type /Pages /Count 7 0 R>> endobj\n3 0 obj <</Type /Page>> endobj\n%%EOF\n',
      );
      expect(inspectPdf(tree)).toEqual(refusedAs('file.too-complex'));
    });

    it('5: pages written as /Type/Page with no space or as /Pa#67e still count', () => {
      const many = Array.from({ length: MAX_PDF_PAGES + 1 }, () => '<</Type/Pa#67e>>').join(' ');
      expect(inspectPdf(latin(`%PDF-1.4\n${many}\n%%EOF\n`))).toEqual(
        refusedAs('file.too-many-pages'),
      );
    });

    it('6: finds the stream after a comment between >> and stream', () => {
      const z = deflateSync(latin(script));
      const dictionary = `<< /Type /ObjStm /N 1 /First 0 /Filter /FlateDecode /Length ${z.length} >>`;
      for (const gap of [' %c', '\n% c\n% d', '\r%x\r']) {
        expect(inspectPdf(pdfWith(rawStream(dictionary, z, gap)))).toEqual(
          refusedAs('file.active-content'),
        );
      }
    });

    it('6: a comment too long to skip is refused, not guessed', () => {
      const z = deflateSync(latin(script));
      const dictionary = `<< /Type /ObjStm /N 1 /First 0 /Filter /FlateDecode >>`;
      expect(inspectPdf(pdfWith(rawStream(dictionary, z, ` %${'c'.repeat(5000)}`)))).toEqual(
        refusedAs('file.too-complex'),
      );
    });

    it('accepts the streams of an ordinary PDF: images, fonts and a predictor on an image', () => {
      const image = latin(
        '11 0 obj << /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode /Length 4 >>\nstream\n\xff\xd8\xff\xd9\nendstream\nendobj\n' +
          '12 0 obj << /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 3 >> /Length 3 >>\nstream\nabc\nendstream\nendobj\n',
      );
      expect(inspectPdf(pdfWith(image))).toEqual({ ok: true, pageCount: 1 });
    });
  });
});
