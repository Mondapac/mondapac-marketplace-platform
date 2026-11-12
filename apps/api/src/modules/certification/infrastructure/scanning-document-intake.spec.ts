import { err, ok } from '@mondapac/shared-kernel';
import type { MalwareScanner, ScanVerdict } from '../../../platform/malware/malware-scanner';
import type { DocumentIntake, InspectedDocument } from '../application/ports/document-ports';
import { ScanningDocumentIntake } from './scanning-document-intake';

const stored: InspectedDocument = {
  mediaType: 'application/pdf',
  bytes: Buffer.from('%PDF-stored'),
  pageCount: 1,
};
const inner = (refusal?: 'file.unreadable'): DocumentIntake => ({
  inspect: () => Promise.resolve(refusal ? err({ code: refusal }) : ok(stored)),
});
const scanner = (verdict: ScanVerdict, configured = true): MalwareScanner & { seen: Buffer[] } => {
  const seen: Buffer[] = [];
  return {
    configured,
    seen,
    scan: (bytes) => {
      seen.push(bytes);
      return Promise.resolve(verdict);
    },
  };
};

describe('ScanningDocumentIntake', () => {
  it('scans the bytes that would be stored and lets a clean file through', async () => {
    const s = scanner({ status: 'clean' });
    const result = await new ScanningDocumentIntake(inner(), s).inspect(Buffer.from('upload'));
    expect(result).toEqual(ok(stored));
    expect(s.seen).toEqual([stored.bytes]);
  });

  it('refuses an infected file', async () => {
    const result = await new ScanningDocumentIntake(
      inner(),
      scanner({ status: 'infected', signature: 'X' }),
    ).inspect(Buffer.from('upload'));
    expect(result).toEqual(err({ code: 'file.infected' }));
  });

  it('fails closed when the scanner gives no verdict', async () => {
    const result = await new ScanningDocumentIntake(
      inner(),
      scanner({ status: 'unavailable' }),
    ).inspect(Buffer.from('upload'));
    expect(result).toEqual(err({ code: 'file.scan-unavailable' }));
  });

  it('does not scan a file the inner intake refused', async () => {
    const s = scanner({ status: 'clean' });
    const result = await new ScanningDocumentIntake(inner('file.unreadable'), s).inspect(
      Buffer.from('upload'),
    );
    expect(result).toEqual(err({ code: 'file.unreadable' }));
    expect(s.seen).toEqual([]);
  });

  it('passes the inner verdict through when no scanner is configured', async () => {
    const s = scanner({ status: 'unavailable' }, false);
    const result = await new ScanningDocumentIntake(inner(), s).inspect(Buffer.from('upload'));
    expect(result).toEqual(ok(stored));
    expect(s.seen).toEqual([]);
  });
});
