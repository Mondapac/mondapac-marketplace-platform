import { EmptyState, LoadError, PageHeader } from '@mondapac/ui';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import {
  CHECK_PERMISSION,
  DECIDE_PERMISSION,
  OWNER_RESET_PERMISSION,
  SUSPEND_PERMISSION,
  REVIEW_PERMISSION,
  SETTINGS_EDIT_PERMISSION,
  type ReviewRead,
} from '../../../../src/sellers/review-types.ts';
import { SellerHealthCard } from '../../../../src/sellers/health-card.tsx';
import {
  HEALTH_RECALCULATE_PERMISSION,
  SELLER_VIEW_PERMISSION,
  healthPath,
  type SellerHealthRead,
} from '../../../../src/sellers/health-types.ts';
import { AiAccessCard } from '../../../../src/sellers/ai-access-card.tsx';
import {
  aiAccessOf,
  aiAccessPath,
  type AiAccessRead,
} from '../../../../src/sellers/ai-access-types.ts';
import { BlogAccessCard } from '../../../../src/sellers/blog-access-card.tsx';
import {
  BLOG_ACCESS_PERMISSION,
  blogAccessOf,
  blogAccessPath,
  type BlogAccessRead,
} from '../../../../src/sellers/blog-access-types.ts';
import { OfferReviewCard } from '../../../../src/sellers/offer-review-card.tsx';
import {
  FLAG_PERMISSIONS,
  STANDING_VIEW_PERMISSIONS,
  flagsOf,
  flagsPath,
  standingOf,
  standingPath,
  type Flags,
  type Standing,
} from '../../../../src/offer-review/standing.ts';
import { CategoryProposalsCard } from '../../../../src/sellers/category-proposals-card.tsx';
import { DECIDE_PERMISSION as PROPOSAL_DECIDE_PERMISSION } from '../../../../src/categories/proposals/types.ts';
import { OwnerSecondFactorCard } from '../../../../src/sellers/owner-second-factor-card.tsx';
import { SellerAccessCard } from '../../../../src/sellers/seller-access-card.tsx';
import { BackToSellers, ReviewView } from '../../../../src/sellers/review-view.tsx';
import { CommissionRateCard } from '../../../../src/commission/rate-card.tsx';
import { LedgerCard } from '../../../../src/commission/ledger-card.tsx';
import {
  RATE_EDIT_PERMISSION,
  SETTLEMENT_VIEW_PERMISSION,
  type CommissionRate,
  type Ledger,
} from '../../../../src/commission/types.ts';
import { PayoutHoldsCard } from '../../../../src/payouts/holds-card.tsx';
import { PayoutTermsCard } from '../../../../src/payouts/terms-card.tsx';
import {
  HOLD_PLACE_PERMISSION,
  HOLD_VIEW_PERMISSION,
  TERMS_EDIT_PERMISSION,
  TERMS_VIEW_PERMISSION,
  type PayoutTerms,
} from '../../../../src/payouts/seller-types.ts';
import { SellerActivitiesCard } from '../../../../src/sellers/seller-activities-card.tsx';
import { SellerEditForm } from '../../../../src/sellers/seller-edit-form.tsx';
import {
  ACTIVITIES_MANAGE_PERMISSION,
  ACTIVITIES_VIEW_PERMISSION,
  CATALOG_ACTIVITY_READ_PERMISSION,
  sellerActivitiesPath,
  type ActivityOption,
  type SellerActivities,
} from '../../../../src/sellers/activities-types.ts';
import { RefundLimitCard } from '../../../../src/refund-limits/seller-card.tsx';
import {
  REFUND_LIMITS_MANAGE_PERMISSION,
  REFUND_LIMITS_VIEW_PERMISSION,
  sellerReadPath,
  type RefundLimits,
} from '../../../../src/refund-limits/types.ts';
import { displayZone, localZone } from '../../../../src/shared/format.ts';
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

/** The caps on the seller's refunds, or null when the role cannot see them or they cannot be read. */
async function loadRefundLimits(sellerId: string, canView: boolean): Promise<RefundLimits | null> {
  if (!canView) return null;
  const read = await serverGet<RefundLimits>(sellerReadPath(sellerId));
  if (read.kind === 'signed-out') redirect('/session-ended');
  return read.kind === 'ok' ? read.body : null;
}

/** The seller's stored health, or null when the role cannot see it or it cannot be read. */
async function loadHealth(sellerId: string, canView: boolean): Promise<SellerHealthRead | null> {
  if (!canView) return null;
  const read = await serverGet<SellerHealthRead>(healthPath(sellerId));
  if (read.kind === 'signed-out') redirect('/session-ended');
  return read.kind === 'ok' ? read.body : null;
}

/** The seller's Offer review flags, or null when the role cannot see them or they cannot be read. */
async function loadReviewFlags(sellerId: string, canView: boolean): Promise<Flags | null> {
  if (!canView) return null;
  const read = await serverGet<unknown>(flagsPath(sellerId));
  if (read.kind === 'signed-out') redirect('/session-ended');
  return read.kind === 'ok' ? flagsOf(read.body) : null;
}

/** The seller's Offer review standing, or null when the role cannot see it or it cannot be read. */
async function loadStanding(sellerId: string, canView: boolean): Promise<Standing | null> {
  if (!canView) return null;
  const read = await serverGet<unknown>(standingPath(sellerId));
  if (read.kind === 'signed-out') redirect('/session-ended');
  return read.kind === 'ok' ? standingOf(read.body) : null;
}

/** The seller's AI switch, or null when it cannot be read (the card then shows no switch). */
async function loadAiAccess(sellerId: string, canView: boolean): Promise<AiAccessRead | null> {
  if (!canView) return null;
  const read = await serverGet<unknown>(aiAccessPath(sellerId));
  if (read.kind === 'signed-out') redirect('/session-ended');
  return read.kind === 'ok' ? aiAccessOf(read.body) : null;
}

/** The seller's blog switch, or null when it cannot be read (the card then shows no switch). */
async function loadBlogAccess(sellerId: string, canView: boolean): Promise<BlogAccessRead | null> {
  if (!canView) return null;
  const read = await serverGet<unknown>(blogAccessPath(sellerId));
  if (read.kind === 'signed-out') redirect('/session-ended');
  return read.kind === 'ok' ? blogAccessOf(read.body) : null;
}

/** The seller's payout terms, or null when the role cannot see them or they cannot be read. */
async function loadTerms(sellerId: string, canView: boolean): Promise<PayoutTerms | null> {
  if (!canView) return null;
  const read = await serverGet<PayoutTerms>(
    `commission-payouts/admin/sellers/${sellerId}/payout-terms`,
  );
  if (read.kind === 'signed-out') redirect('/session-ended');
  return read.kind === 'ok' ? read.body : null;
}

/** The activities the seller carries, or null when the role cannot see them or they cannot be read. */
async function loadActivities(
  sellerId: string,
  permissionKeys: readonly string[],
): Promise<{ readonly seller: SellerActivities; readonly options: ActivityOption[] } | null> {
  if (!permissionKeys.includes(ACTIVITIES_VIEW_PERMISSION)) return null;
  const read = await serverGet<SellerActivities>(sellerActivitiesPath(sellerId));
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') return null;
  // The names come from the catalog list; a role without its key still sees the set, unnamed.
  let options: ActivityOption[] = [];
  if (permissionKeys.includes(CATALOG_ACTIVITY_READ_PERMISSION)) {
    const list = await serverGet<{
      items: { id: string; status: string; names: Record<string, string>; code: string }[];
      locales: { default: string };
    }>('catalog/admin/business-activities?limit=100');
    if (list.kind === 'ok') {
      options = list.body.items.map((a) => ({
        id: a.id,
        name: a.names[list.body.locales.default] ?? a.code,
        active: a.status === 'active',
      }));
    }
  }
  return { seller: read.body, options };
}

type CommissionRead =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ok'; readonly rate: CommissionRate; readonly ledger: Ledger };

/** The seller's commission rate and first ledger page; hidden for a role without the view key. */
async function loadCommission(sellerId: string, canView: boolean): Promise<CommissionRead> {
  if (!canView) return { kind: 'hidden' };
  const base = `commission-payouts/admin/sellers/${sellerId}`;
  // One row only: the page needs the Market currency and the totals (they cover every row); the
  // ledger list reads its own rows.
  const [rate, ledger] = await Promise.all([
    serverGet<CommissionRate>(`${base}/commission-rate`),
    serverGet<Ledger>(`${base}/ledger?limit=1`),
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
          <PageHeader title={t('sellers.review.unavailable.title')} />
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
    const [
      commission,
      methods,
      terms,
      health,
      activities,
      aiAccess,
      blogAccess,
      refundLimits,
      reviewFlags,
      reviewStanding,
    ] = await Promise.all([
      loadCommission(sellerId, permissionKeys.includes(SETTLEMENT_VIEW_PERMISSION)),
      loadMethods(sellerId, permissionKeys.includes(DELIVERY_VIEW_PERMISSION)),
      loadTerms(sellerId, permissionKeys.includes(TERMS_VIEW_PERMISSION)),
      loadHealth(sellerId, permissionKeys.includes(SELLER_VIEW_PERMISSION)),
      loadActivities(sellerId, permissionKeys),
      loadAiAccess(sellerId, permissionKeys.includes(SELLER_VIEW_PERMISSION)),
      loadBlogAccess(sellerId, permissionKeys.includes(SELLER_VIEW_PERMISSION)),
      loadRefundLimits(sellerId, permissionKeys.includes(REFUND_LIMITS_VIEW_PERMISSION)),
      loadReviewFlags(sellerId, permissionKeys.includes(SELLER_VIEW_PERMISSION)),
      loadStanding(
        sellerId,
        STANDING_VIEW_PERMISSIONS.every((key) => permissionKeys.includes(key)),
      ),
    ]);
    const canViewHolds = permissionKeys.includes(HOLD_VIEW_PERMISSION);
    // List paging (settings): page numbers only when the Market says so; a value that cannot be
    // read (or may not be read) means Previous and next. Read only for the lists that need it.
    const [mode, host] =
      commission.kind === 'ok' || canViewHolds
        ? await Promise.all([
            serverGet<{ readonly listPaging: string }>('settings/admin/list-paging'),
            headers(),
          ])
        : [null, null];
    const paging = mode?.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
    const marketId =
      host === null ? '' : (panelHostFor(panelConfig(), host.get('host'))?.marketId ?? '');
    const zone = localZone(gate.session.timezone, gate.session.marketTimezone);
    return shell(
      <div className="flex flex-col gap-6">
        <ReviewView review={result.body} decide={decide} />
        {/* Suspend or lift: only for a holder of the key, in a state where it applies (SEL-07). */}
        {permissionKeys.includes(SUSPEND_PERMISSION) &&
        (result.body.access === 'approved' || result.body.access === 'suspended') ? (
          <SellerAccessCard sellerId={sellerId} access={result.body.access} csrfToken={csrfToken} />
        ) : null}
        {permissionKeys.includes('customers.customers.view') ? (
          // The seller's Customers tab (customers management phase 3): its own page.
          <nav aria-label={t('customers.seller-tab.nav')}>
            <a
              href={`/sellers/${sellerId}/customers`}
              className="font-medium text-link underline focus-visible:outline-2 focus-visible:outline-focus"
            >
              {t('customers.seller-tab.link')}
            </a>
          </nav>
        ) : null}
        {health === null ? null : (
          <SellerHealthCard
            sellerId={sellerId}
            initial={health}
            canRecalculate={permissionKeys.includes(HEALTH_RECALCULATE_PERMISSION)}
            csrfToken={csrfToken}
          />
        )}
        {reviewFlags === null && reviewStanding === null ? null : (
          <OfferReviewCard
            sellerId={sellerId}
            csrfToken={csrfToken}
            standing={reviewStanding}
            initial={reviewFlags}
            can={{
              trusted: permissionKeys.includes(FLAG_PERMISSIONS.trusted),
              'full-review': permissionKeys.includes(FLAG_PERMISSIONS['full-review']),
              stop: permissionKeys.includes(FLAG_PERMISSIONS.stop),
            }}
            zone={zone}
          />
        )}
        {permissionKeys.includes(SETTINGS_EDIT_PERMISSION) ? (
          <CategoryProposalsCard
            sellerId={sellerId}
            csrfToken={csrfToken}
            canSeeQueue={permissionKeys.includes(PROPOSAL_DECIDE_PERMISSION)}
          />
        ) : null}
        {permissionKeys.includes(SETTINGS_EDIT_PERMISSION) ? (
          <AiAccessCard
            sellerId={sellerId}
            csrfToken={csrfToken}
            initial={aiAccess}
            canView={permissionKeys.includes(SELLER_VIEW_PERMISSION)}
          />
        ) : null}
        {permissionKeys.includes(BLOG_ACCESS_PERMISSION) ||
        permissionKeys.includes(SELLER_VIEW_PERMISSION) ? (
          <BlogAccessCard
            sellerId={sellerId}
            csrfToken={csrfToken}
            initial={blogAccess}
            canView={permissionKeys.includes(SELLER_VIEW_PERMISSION)}
            canEdit={permissionKeys.includes(BLOG_ACCESS_PERMISSION)}
          />
        ) : null}
        {refundLimits === null ? null : (
          <RefundLimitCard
            sellerId={sellerId}
            initial={refundLimits}
            canManage={permissionKeys.includes(REFUND_LIMITS_MANAGE_PERMISSION)}
            csrfToken={csrfToken}
            zone={displayZone(gate.session.timezone)}
          />
        )}
        {/* One save bar for the editable parts; each saves through its own API, in turn. */}
        <SellerEditForm
          order={['activities', 'delivery-methods', 'commission-rate']}
          page={t('sellers.review.title')}
        >
          {activities === null ? null : (
            <SellerActivitiesCard
              sellerId={sellerId}
              initial={activities.seller}
              activities={activities.options}
              canEdit={
                permissionKeys.includes(ACTIVITIES_MANAGE_PERMISSION) &&
                activities.options.length > 0
              }
              editNote={
                permissionKeys.includes(ACTIVITIES_MANAGE_PERMISSION) &&
                activities.options.length === 0
              }
              csrfToken={csrfToken}
            />
          )}
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
        </SellerEditForm>
        {terms === null && !canViewHolds ? null : (
          // Stacked, not side by side: the holds table needs the full width to stay unscrolled.
          <div className="flex flex-col gap-6">
            {terms === null ? null : (
              <PayoutTermsCard
                initial={terms}
                // The terms answer carries minor units only; the Market currency is the ledger's.
                currency={commission.kind === 'ok' ? commission.ledger.currency : null}
                canEdit={permissionKeys.includes(TERMS_EDIT_PERMISSION)}
                csrfToken={csrfToken}
              />
            )}
            {canViewHolds ? (
              <PayoutHoldsCard
                sellerId={sellerId}
                paging={paging}
                accountId={gate.session.accountId}
                marketId={marketId}
                zone={zone}
                canPlace={permissionKeys.includes(HOLD_PLACE_PERMISSION)}
                csrfToken={csrfToken}
              />
            ) : null}
          </div>
        )}
        {commission.kind === 'ok' ? (
          <LedgerCard
            sellerId={sellerId}
            currency={commission.ledger.currency}
            initialTotals={commission.ledger.totals}
            paging={paging}
            accountId={gate.session.accountId}
            marketId={marketId}
            zone={zone}
          />
        ) : null}
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
