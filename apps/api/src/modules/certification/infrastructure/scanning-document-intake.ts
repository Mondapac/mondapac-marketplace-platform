import { err } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { MalwareScanner } from '../../../platform/malware/malware-scanner';
import type { DocumentRefusalCode } from '../application/intake/document-inspection';
import type { DocumentIntake, InspectedDocument } from '../application/ports/document-ports';

type Refusal = { readonly code: DocumentRefusalCode };

/**
 * {@link DocumentIntake} that scans what the inner intake accepted (file storage pilot F12). The
 * bytes scanned are the bytes that would be stored (an image written again from its pixels). With
 * a scanner configured it fails closed: only a clean verdict lets the file through; an infected
 * file is `file.infected` and no clean verdict is `file.scan-unavailable`. With no scanner
 * configured the inner verdict stands: start-up refuses reviewer file downloads in that case, so
 * unscanned files are never opened by a reviewer.
 */
export class ScanningDocumentIntake implements DocumentIntake {
  constructor(
    private readonly inner: DocumentIntake,
    private readonly scanner: MalwareScanner,
  ) {}

  async inspect(bytes: Buffer): Promise<Result<InspectedDocument, Refusal>> {
    const inspected = await this.inner.inspect(bytes);
    if (!inspected.ok || !this.scanner.configured) return inspected;
    const verdict = await this.scanner.scan(inspected.value.bytes);
    if (verdict.status === 'clean') return inspected;
    return err({ code: verdict.status === 'infected' ? 'file.infected' : 'file.scan-unavailable' });
  }
}
