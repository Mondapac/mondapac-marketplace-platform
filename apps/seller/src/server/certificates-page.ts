import 'server-only';
import { redirect } from 'next/navigation';
import {
  CERTIFICATE_VIEW_PERMISSION,
  type CertificateDetail,
  type CertificateList,
  type CertificateOptions,
  type SellerAccountState,
} from '../certificates/types.ts';
import type { MyFile } from '../setup/types.ts';
import { readSellerZone } from './seller-zone.ts';
import { serverGet, type ServerGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

/** The setup statuses as the account setup shows them (setup-hub.tsx); anything else: details. */
function accountStateOf(file: MyFile | null, session: SellerSession): SellerAccountState {
  if (session.sellerAccessState === 'approved') return 'approved';
  if (session.sellerAccessState === 'rejected') return 'not-approved';
  switch (file?.status) {
    case 'awaiting-review':
      return 'awaiting-review';
    case 'changes-needed':
      return 'changes-needed';
    case 'not-approved':
      return 'not-approved';
    case 'outside-service-area':
      return 'outside-area';
    case 'ready-to-submit':
      return 'ready';
    default:
      return 'details-incomplete';
  }
}

async function accountState(session: SellerSession): Promise<SellerAccountState> {
  if (session.sellerAccessState !== 'pending') return accountStateOf(null, session);
  const file = await serverGet<MyFile>('sellers/my-file');
  return accountStateOf(file.kind === 'ok' ? file.body : null, session);
}

type Failed =
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  /** `session` is set when only the data failed to load: the page then keeps its settings shell. */
  | { readonly kind: 'unavailable'; readonly session?: SellerSession };

/** The list holds one open certificate per type, so a few pages at most; all are read. */
const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGES = 10;

async function readAllCertificates(): Promise<ServerGet<CertificateList>> {
  const rows: CertificateList['certificates'][number][] = [];
  let after: string | null = null;
  for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
    const query: string = `limit=${LIST_PAGE_SIZE}${after === null ? '' : `&afterId=${after}`}`;
    const read: ServerGet<CertificateList> = await serverGet<CertificateList>(
      `certification/seller/certificates?${query}`,
    );
    if (read.kind !== 'ok') return read;
    rows.push(...read.body.certificates);
    after = read.body.nextAfterId;
    if (after === null) break;
  }
  return { kind: 'ok', body: { certificates: rows, nextAfterId: after } };
}

export type CertificatesListPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly list: CertificateList;
      readonly options: CertificateOptions;
      readonly account: SellerAccountState;
    }
  | Failed;

/**
 * The session and the seller's certificates for Settings › Certificates. Unlike every other
 * settings page it opens before approval too: a seller may send a certificate with the
 * application (ux.md FL1). The API authorises every read again.
 */
export async function loadCertificatesListPage(): Promise<CertificatesListPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (!session.permissionKeys.includes(CERTIFICATE_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const [list, options, account] = await Promise.all([
    readAllCertificates(),
    serverGet<CertificateOptions>('certification/seller/certificate-options'),
    accountState(session),
  ]);
  if (list.kind === 'signed-out' || options.kind === 'signed-out') redirect('/session-ended');
  if (list.kind === 'forbidden' || options.kind === 'forbidden') {
    return { kind: 'no-access', session };
  }
  if (list.kind !== 'ok' || options.kind !== 'ok') return { kind: 'unavailable', session };
  return { kind: 'ok', session, list: list.body, options: options.body, account };
}

export type CertificatePage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly detail: CertificateDetail;
      readonly options: CertificateOptions;
      /** The seller's working zone, for the expiry line; null when it could not be read. */
      readonly zone: string | null;
    }
  | { readonly kind: 'not-found'; readonly session: SellerSession }
  | Failed;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One of the seller's own certificates with its draft, and the type's form settings. */
export async function loadCertificatePage(certificateId: string): Promise<CertificatePage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (!session.permissionKeys.includes(CERTIFICATE_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  if (!UUID.test(certificateId)) return { kind: 'not-found', session };
  const [detail, options, zone] = await Promise.all([
    serverGet<CertificateDetail>(`certification/seller/certificates/${certificateId}`),
    serverGet<CertificateOptions>('certification/seller/certificate-options'),
    readSellerZone(),
  ]);
  if (detail.kind === 'signed-out' || options.kind === 'signed-out') redirect('/session-ended');
  if (detail.kind === 'not-found') return { kind: 'not-found', session };
  if (detail.kind === 'forbidden' || options.kind === 'forbidden') {
    return { kind: 'no-access', session };
  }
  if (detail.kind !== 'ok' || options.kind !== 'ok') return { kind: 'unavailable', session };
  return { kind: 'ok', session, detail: detail.body, options: options.body, zone };
}
