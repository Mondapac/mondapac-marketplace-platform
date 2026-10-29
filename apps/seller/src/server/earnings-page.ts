import 'server-only';
import { redirect } from 'next/navigation';
import type { OwnDispute } from '../disputes/types.ts';
import { EARNINGS_VIEW_PERMISSION, type Ledger } from '../earnings/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { loadOwnDisputes } from './own-disputes.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type EarningsPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly ledger: Ledger;
      readonly disputes: readonly OwnDispute[];
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session and the first page of the seller's own ledger. */
export async function loadEarningsPage(): Promise<EarningsPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(EARNINGS_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const [ledger, disputes] = await Promise.all([
    serverGet<Ledger>('commission-payouts/seller/ledger?limit=20'),
    loadOwnDisputes(),
  ]);
  if (ledger.kind === 'signed-out') redirect('/session-ended');
  if (ledger.kind !== 'ok') return { kind: 'unavailable' };
  return { kind: 'ok', session, ledger: ledger.body, disputes };
}
