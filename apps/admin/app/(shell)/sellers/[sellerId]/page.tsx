import { EmptyState, LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import {
  CHECK_PERMISSION,
  DECIDE_PERMISSION,
  OWNER_RESET_PERMISSION,
  REVIEW_PERMISSION,
  type ReviewRead,
} from '../../../../src/sellers/review-types.ts';
import { OwnerSecondFactorCard } from '../../../../src/sellers/owner-second-factor-card.tsx';
import { BackToSellers, ReviewView } from '../../../../src/sellers/review-view.tsx';
import { CommissionRateCard } from '../../../../src/commission/rate-card.tsx';
import { LedgerCard } from '../../../../src/commission/ledger-card.tsx';
import {
  RATE_EDIT_PERMISSION,
  SETTLEMENT_VIEW_PERMISSION,
  type CommissionRate,
  type Ledger,
} from '../../../../src/commission/types.ts';
import { SellerMethodsCard } from '../../../../src/delivery-settings/seller-methods-card.tsx';
import {
  DELIVERY_MANAGE_PERMISSION,
  DELIVERY_VIEW_PERMISSION,
  sellerMethodsPath,
  type SellerMethods,
} from '../../../../src/delivery-settings/types.ts';
/** The delivery methods the seller supports, or null when the role cannot see them or they cannot be read. */
async function loadMethods(sellerId: string, canView: boolean): Promise<SellerMethods | null> {
  if (!canView) return null;
  const read = await serverGet<SellerMethods>(sellerMethodsPath(sellerId));
  if (read.kind === 'signed-out') redirect('/session-ended');
  return read.kind === 'ok' ? read.body : null;
}

type CommissionRead =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ok'; readonly rate: CommissionRate; readonly ledger: Ledger };

/** The seller's commission rate and first ledger page; hidden for a role without the view key. */
async function loadCommission(sellerId: string, canView: boolean): Promise<CommissionRead> {
  if (!canView) return { kind: 'hidden' };
  const base = `commission-payouts/admin/sellers/${sellerId}`;
  const [rate, ledger] = await Promise.all([
    serverGet<CommissionRate>(`${base}/commission-rate`),
    serverGet<Ledger>(`${base}/ledger?limit=20`),
  ]);
  if (rate.kind === 'signed-out' || ledger.kind === 'signed-out') redirect('/session-ended');
  if (rate.kind === 'forbidden' || ledger.kind === 'forbidden') return { kind: 'hidden' };
  if (rate.kind !== 'ok' || ledger.kind !== 'ok') return { kind: 'unavailable' };
  return { kind: 'ok', rate: rate.body, ledger: ledger.body };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('sellers.review.title') };
}

export default async function SellerReviewPage({
  params,
}: {
  readonly params: Promise<{ readonly sellerId: string }>;
}) {
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('sellers.review.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="sellers" title={title}>
      {body}
    </AdminShell>
  );
  // A page with nothing to show is a page-size empty state: its title is the h1 and the way
  // back to the list is its action. A load failure keeps the retry of LoadError.
  const message = (key: 'no-access' | 'not-found' | 'no-revision' | 'unavailable') =>
    shell(
      key === 'unavailable' ? (
        <div className="flex flex-col gap-4">
          <div>
            <BackToSellers label={t('sellers.review.back')} />
          </div>
          <h1 className="text-2xl font-semibold">{t('sellers.review.unavailable.title')}</h1>
          <LoadError
            className="flex flex-col items-start gap-3"
            message={t('sellers.review.unavailable.body')}
            retryLabel={t('load.retry')}
          />
        </div>
      ) : (
        <EmptyState
          size="page"
          icon={key === 'no-access' ? 'lock' : 'store'}
          title={t(`sellers.review.${key}.title`)}
          body={t(`sellers.review.${key}.body`)}
          action={<BackToSellers label={t('sellers.review.back')} />}
        />
      ),
    );
  // The API audits every read of business details, so a page without the permission makes no call.
  if (!gate.session.permissionKeys.includes(REVIEW_PERMISSION)) return message('no-access');
  const result = await serverGet<ReviewRead>(`sellers/admin/${sellerId}/review`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'ok') {
    const { permissionKeys, csrfToken } = gate.session;
    const decide = {
      canDecide: permissionKeys.includes(DECIDE_PERMISSION),
      canCheck: permissionKeys.includes(CHECK_PERMISSION),
      csrfToken,
    };
    const [commission, methods] = await Promise.all([
      loadCommission(sellerId, permissionKeys.includes(SETTLEMENT_VIEW_PERMISSION)),
      loadMethods(sellerId, permissionKeys.includes(DELIVERY_VIEW_PERMISSION)),
    ]);
    return shell(
      <div className="flex flex-col gap-6">
        <ReviewView review={result.body} decide={decide} />
        {commission.kind === 'hidden' && methods === null ? null : (
          <div className="grid gap-6 lg:grid-cols-2">
            {methods === null ? null : (
              <SellerMethodsCard
                initial={methods}
                canManage={permissionKeys.includes(DELIVERY_MANAGE_PERMISSION)}
                csrfToken={csrfToken}
              />
            )}
            {commission.kind === 'ok' ? (
              <CommissionRateCard
                initial={commission.rate}
                canEdit={permissionKeys.includes(RATE_EDIT_PERMISSION)}
                csrfToken={csrfToken}
              />
            ) : null}
          </div>
        )}
        {commission.kind === 'ok' ? <LedgerCard initial={commission.ledger} /> : null}
        {commission.kind === 'unavailable' ? (
          <LoadError
            className="flex flex-col items-start gap-3 rounded-lg border border-line p-5"
            message={t('commission.ledger.unavailable')}
            retryLabel={t('load.retry')}
          />
        ) : null}
        {/* The action shows only to an actor who holds its key; the server checks it again. */}
        {permissionKeys.includes(OWNER_RESET_PERMISSION) ? (
          <OwnerSecondFactorCard sellerId={sellerId} csrfToken={csrfToken} />
        ) : null}
      </div>,
    );
  }
  if (result.kind === 'forbidden') return message('no-access');
  if (result.kind === 'not-found') return message('not-found');
  if (result.kind === 'conflict') return message('no-revision');
  return message('unavailable');
}
