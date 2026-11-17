'use client';

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  LoadError,
  Select,
  SkeletonRows,
  toast,
  type BadgeTone,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { languageName } from '../../attributes/types.ts';
import { When } from '../../shared/when.tsx';
import { directionOf } from '../tree-model.ts';
import { API_CATEGORIES, type TreeBody } from '../types.ts';
import { headline, pathText } from './model.ts';
import { ShelvesPanel } from './shelves-panel.tsx';
import {
  API_PROPOSALS,
  REJECT_REASONS,
  type Proposal,
  type ProposalDecided,
  type ProposalQueue,
} from './types.ts';
import { useWrite } from './use-write.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly tree: TreeBody; readonly queue: ProposalQueue }
  | { readonly state: 'denied' }
  | { readonly state: 'failed' };

/** A row that was decided here keeps its place and shows how it closed. */
interface Closed {
  readonly status: ProposalDecided['status'];
  readonly reasonCode: string | null;
}

const OUTCOME_TONE: Record<string, BadgeTone> = {
  approved: 'success',
  rejected: 'neutral',
  cancelled: 'neutral',
};

/**
 * The Category proposals tab (categories C9b; CAT-52, ux FP8 row 4): the proposals sellers made
 * and nobody decided yet, oldest first. Approve makes a shelf of the seller's shop, never a
 * platform category. Reject takes one prepared reason. A row decided here, or closed by the
 * seller losing the permission, shows its outcome in place. A seller's shelves open below the
 * queue, where an admin with the promote-merge key can promote or merge them.
 */
export function ProposalsTab({
  csrfToken,
  canPromote,
  initialSellerId = null,
}: {
  readonly csrfToken: string;
  readonly canPromote: boolean;
  readonly initialSellerId?: string | null;
}) {
  const t = useTranslations('categories.proposals');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [more, setMore] = useState<readonly Proposal[]>([]);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [closed, setClosed] = useState<Readonly<Record<string, Closed>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [shelfOf, setShelfOf] = useState<{ id: string; name: string | null } | null>(
    initialSellerId === null ? null : { id: initialSellerId, name: null },
  );

  const fetchAll = useCallback(async (quiet = false) => {
    if (!quiet) setLoad({ state: 'loading' });
    const [tree, queue] = await Promise.all([
      callApi<TreeBody>('GET', API_CATEGORIES),
      callApi<ProposalQueue>('GET', API_PROPOSALS),
    ]);
    if (tree.ok && queue.ok) {
      setMore([]);
      setNextAfter(queue.body.nextAfterId);
      setLoad({ state: 'ready', tree: tree.body, queue: queue.body });
      return;
    }
    const failure = !tree.ok ? tree.failure : !queue.ok ? queue.failure : null;
    if (failure?.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (quiet) {
      setNotice('reload-failed');
      return;
    }
    setLoad({ state: failure?.status === 403 ? 'denied' : 'failed' });
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  async function loadMore() {
    if (nextAfter === null || loadingMore) return;
    setLoadingMore(true);
    const result = await callApi<ProposalQueue>(
      'GET',
      `${API_PROPOSALS}?afterId=${encodeURIComponent(nextAfter)}`,
    );
    setLoadingMore(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setNotice('reload-failed');
      return;
    }
    setMore((previous) => [...previous, ...result.body.items]);
    setNextAfter(result.body.nextAfterId);
  }

  if (load.state === 'denied') return <Banner tone="info">{t('denied')}</Banner>;
  if (load.state === 'loading') return <SkeletonRows label={t('loading')} rows={3} />;
  if (load.state === 'failed') {
    return (
      <LoadError
        message={t('load-failed')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchAll()}
      />
    );
  }
  const { tree } = load;
  const items = [...load.queue.items, ...more];
  const shelves =
    shelfOf === null ? null : (
      <ShelvesPanel
        key={shelfOf.id}
        sellerId={shelfOf.id}
        storeName={shelfOf.name}
        tree={tree}
        canPromote={canPromote}
        csrfToken={csrfToken}
        onClose={() => setShelfOf(null)}
        onTreeChanged={() => void fetchAll(true)}
      />
    );
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="proposals-heading" className="flex flex-col gap-4">
        <h2 id="proposals-heading" className="text-lg font-semibold text-fg">
          {t('title')}
        </h2>
        <p className="max-w-prose text-fg-muted">{t('intro')}</p>
        {notice === null ? null : (
          <div role="alert">
            <Banner tone="info">{t(`error.${notice}`)}</Banner>
          </div>
        )}
        {items.length === 0 ? (
          <EmptyState size="card" icon="inbox" title={t('empty')} body={t('empty-body')} />
        ) : (
          <ul className="flex flex-col gap-4" aria-label={t('list-label')}>
            {items.map((item) => (
              <li key={item.id}>
                <ProposalCard
                  item={item}
                  tree={tree}
                  closed={closed[item.id] ?? null}
                  csrfToken={csrfToken}
                  onShelves={() => setShelfOf({ id: item.sellerId, name: item.storeName })}
                  onDecided={(outcome) => {
                    setNotice(null);
                    setClosed((previous) => ({ ...previous, [item.id]: outcome }));
                  }}
                  onStale={() => {
                    setNotice('stale');
                    void fetchAll(true);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {nextAfter === null ? null : (
          <div>
            <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
              {t('load-more')}
            </Button>
          </div>
        )}
      </section>
      {shelves}
    </div>
  );
}

/** The words of how a proposal closed. */
export function ClosedBadge({ status, reasonCode }: Closed) {
  const t = useTranslations('categories.proposals');
  const text =
    status === 'approved'
      ? t('closed.approved')
      : status === 'rejected'
        ? t('closed.rejected', { reason: t(`reason.${reasonCode ?? 'other'}`) })
        : reasonCode === 'permission-revoked'
          ? t('closed.permission-revoked')
          : t('closed.cancelled');
  return <Badge tone={OUTCOME_TONE[status] ?? 'neutral'}>{text}</Badge>;
}

function ProposalCard({
  item,
  tree,
  closed,
  csrfToken,
  onShelves,
  onDecided,
  onStale,
}: {
  readonly item: Proposal;
  readonly tree: TreeBody;
  readonly closed: Closed | null;
  readonly csrfToken: string;
  readonly onShelves: () => void;
  readonly onDecided: (outcome: Closed) => void;
  readonly onStale: () => void;
}) {
  const t = useTranslations('categories.proposals');
  const write = useWrite(csrfToken);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const card = useRef<HTMLElement>(null);
  const opened = useRef(false);
  const outcome: Closed | null =
    closed ??
    (item.status === 'pending' ? null : { status: item.status, reasonCode: item.reasonCode });
  const parentPath = pathText(tree.categories, item.platformParentId, tree.defaultLocale);
  const title = headline(item.texts, tree.defaultLocale);

  // Opening the reject form moves focus into it; cancelling returns it to the first action.
  useEffect(() => {
    if (rejecting) {
      opened.current = true;
      card.current?.querySelector<HTMLElement>('form select')?.focus();
    } else if (opened.current) {
      opened.current = false;
      card.current?.querySelector<HTMLElement>('button')?.focus();
    }
  }, [rejecting]);

  async function decide(action: 'approve' | 'reject') {
    const body =
      action === 'approve'
        ? { version: item.version }
        : { version: item.version, reasonCode: reason };
    const result = await write.run<ProposalDecided>(`${API_PROPOSALS}/${item.id}/${action}`, body);
    if (result.ok) {
      toast.success(t(`decided.${result.body.status}`));
      setRejecting(false);
      onDecided({
        status: result.body.status,
        reasonCode:
          result.body.status === 'rejected'
            ? reason
            : result.body.status === 'cancelled'
              ? 'permission-revoked'
              : null,
      });
      return;
    }
    if (result.problem?.reload === true && result.problem.key !== 'category-proposal_not-allowed') {
      onStale();
    }
  }

  return (
    <section ref={card} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-base font-semibold wrap-anywhere text-fg">
          {item.storeName ?? t('unknown-store')}
        </h3>
        {outcome === null ? (
          <Badge tone="attention">{t('waiting')}</Badge>
        ) : (
          <ClosedBadge {...outcome} />
        )}
      </div>
      <p className="mt-1 text-sm text-fg-muted">
        {t('under', { path: parentPath === '' ? t('unknown-parent') : parentPath })} ·{' '}
        <When iso={item.createdAt} missing="" />
      </p>
      <ul className="mt-3 flex flex-col gap-1" aria-label={t('names-label', { name: title })}>
        {item.texts.map((text) => (
          <li key={text.locale} className="text-sm">
            <span className="text-fg-muted">
              {languageName(text.locale, tree.supportedLocales)}:{' '}
            </span>
            <span lang={text.locale} dir={directionOf(text.locale)} className="font-medium text-fg">
              {text.name}
            </span>
            {text.description === null || text.description === '' ? null : (
              <span
                lang={text.locale}
                dir={directionOf(text.locale)}
                className="block text-fg-muted"
              >
                {text.description}
              </span>
            )}
          </li>
        ))}
      </ul>
      {write.problem === null ? null : (
        <div className="mt-3" role="alert">
          <Banner tone="critical">
            {t(`error.${write.problem.key}`, { max: write.problem.max ?? 0 })}
          </Banner>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        {outcome === null && !rejecting ? (
          <>
            <Button
              aria-label={t('approve-for', { name: title })}
              loading={write.pending}
              disabled={write.pending}
              onClick={() => void decide('approve')}
            >
              {t('approve')}
            </Button>
            <Button
              variant="secondary"
              aria-label={t('reject-for', { name: title })}
              disabled={write.pending}
              onClick={() => setRejecting(true)}
            >
              {t('reject')}
            </Button>
          </>
        ) : null}
        <Button
          variant="secondary"
          aria-label={t('shelves-for', { store: item.storeName ?? t('unknown-store') })}
          onClick={onShelves}
        >
          {t('shelves-open')}
        </Button>
      </div>
      {outcome === null && rejecting ? (
        <form
          className="mt-3 flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (reason !== '') void decide('reject');
          }}
        >
          <div className="w-full sm:w-72">
            <Select
              label={t('reason-label')}
              placeholder={t('reason-choose')}
              value={reason}
              options={REJECT_REASONS.map((code) => ({ value: code, label: t(`reason.${code}`) }))}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <p className="text-sm text-fg-muted">{t('reason-note')}</p>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={write.pending} disabled={write.pending || reason === ''}>
              {t('reject-confirm')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={write.pending}
              onClick={() => setRejecting(false)}
            >
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
