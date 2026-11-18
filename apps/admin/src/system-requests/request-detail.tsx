'use client';

import {
  ActionRow,
  Banner,
  BackLink,
  Button,
  Card,
  DataList,
  EmptyState,
  IconButton,
  LinkButton,
  Menu,
  NoAccess,
  SkeletonRows,
  browserStorage,
  prefsKey,
  readIds,
  toast,
  useDesktop,
  type MenuItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { dayInZone, formatInstantInZone } from '../shared/format.ts';
import { Activity } from './activity.tsx';
import { DecisionDialog, type Decide } from './decision-dialogs.tsx';
import { ChangeDiff } from './diff.tsx';
import type { Refusal } from './errors.ts';
import {
  AreaBadge,
  OverdueText,
  RiskBadge,
  StatusBadges,
  useKindTitle,
  usePersonName,
} from './request-parts.tsx';
import { RefusalBanner } from './refusal-banner.tsx';
import {
  BASE,
  QUEUE_PATH,
  has,
  requestPath,
  subjectHref,
  type ActivityLine,
  type SystemRequestDetail,
} from './types.ts';

type Failure = 'not-found' | 'denied' | 'unavailable';

/**
 * One system request: the header with its badges, facts and actions; the banners that say what
 * the request is (live and waiting, superseded, yours); the author's note; the before and after
 * values; the activity with the comment box. Actions come from `actions` only. A refusal shows
 * at the top and the request loads again, so the page always shows what the API holds.
 */
export function RequestDetail({
  requestId,
  accountId,
  csrfToken,
  zone,
  marketId,
}: {
  readonly requestId: string;
  readonly accountId: string;
  readonly csrfToken: string;
  readonly zone: string;
  /** Names this admin's stored queue address, so Back returns to the same list. */
  readonly marketId: string;
}) {
  const t = useTranslations('system-requests');
  const tl = useTranslations('load');
  const locale = useLocale();
  const desktop = useDesktop();
  const kindTitle = useKindTitle();
  const person = usePersonName(accountId);
  const [request, setRequest] = useState<SystemRequestDetail | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [deciding, setDeciding] = useState<Decide | null>(null);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; kind: Decide; reason: string } | null>(
    null,
  );
  const [backSearch, setBackSearch] = useState('');
  const latest = useRef(0);

  // The queue writes its address to this browser's storage; Back keeps its view and filters.
  useEffect(() => {
    const stored = readIds(
      browserStorage(),
      prefsKey('admin', marketId, accountId, 'system-requests-query'),
    )?.[0];
    if (stored !== undefined) setBackSearch(stored);
  }, [marketId, accountId]);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    const result = await callApi<SystemRequestDetail>('GET', `${BASE}/requests/${requestId}`);
    if (ticket !== latest.current) return;
    if (result.ok) {
      setRequest(result.body);
      setFailure(null);
      return;
    }
    const { failure: problem } = result;
    if (problem.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (problem.status === 404 || problem.code === 'system-requests.not-found') {
      setFailure('not-found');
    } else if (problem.status === 403) setFailure('denied');
    else setFailure('unavailable');
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // After the admin comes back from another tab (an action taken elsewhere), load again.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);

  const back = (
    <BackLink
      href={`${QUEUE_PATH}${backSearch === '' ? '' : `?${backSearch}`}`}
      label={t('title')}
    />
  );

  if (failure === 'not-found') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState
          size="card"
          icon="search"
          title={t('detail.not-found')}
          action={
            <LinkButton variant="secondary" href={QUEUE_PATH}>
              {t('title')}
            </LinkButton>
          }
        />
      </div>
    );
  }
  if (failure === 'denied') {
    return (
      <NoAccess
        title={t('no-access')}
        body={t('no-access-body')}
        backHref="/"
        backLabel={t('back-home')}
      />
    );
  }
  if (failure === 'unavailable' && request === null) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('error.unavailable')}</span>
            <Button variant="secondary" onClick={() => void load()}>
              {tl('retry')}
            </Button>
          </div>
        </Banner>
      </div>
    );
  }
  if (request === null) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <SkeletonRows label={t('loading-request')} rows={4} />
      </div>
    );
  }

  const open = request.status === 'open';
  const superseded = open && request.supersededBy !== null;
  const mine = request.requestedBy === accountId;
  const href = subjectHref(request.subjectKind, request.subjectRef);
  const subjectName = request.subjectLabel ?? request.subjectRef;
  const who = (id: string | null, name?: string | null) =>
    id === accountId ? t('you-lower') : person(id, name);
  const decidedOn = request.decidedAt === null ? '' : dayInZone(request.decidedAt, locale, zone);

  const canApprove = open && has(request, 'approve');
  const canReject = open && has(request, 'reject');
  const canWithdraw = open && has(request, 'withdraw');

  const copyLink = () => {
    const url = `${window.location.origin}${requestPath(request.id)}`;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success(t('link-copied')))
      .catch(() => toast.error(t('link-not-copied')));
  };

  const decide = (kind: Decide) => {
    setRefusal(null);
    setDeciding(kind);
  };
  // The decisions the API lists for the caller, in the order Approve, Reject, Withdraw.
  const decisions: readonly { readonly kind: Decide; readonly danger: boolean }[] = [
    ...(canApprove ? [{ kind: 'approve' as const, danger: false }] : []),
    ...(canReject ? [{ kind: 'reject' as const, danger: true }] : []),
    ...(canWithdraw ? [{ kind: 'withdraw' as const, danger: true }] : []),
  ];
  const buttons = decisions.map((entry) => (
    <Button
      key={entry.kind}
      variant={entry.danger ? 'destructive' : 'primary'}
      onClick={() => decide(entry.kind)}
    >
      {t(`action.${entry.kind}`)}
    </Button>
  ));
  const hasLink = has(request, 'copy-link');
  // On a phone the first action stays on the bar and the others go behind the menu.
  const overflow: MenuItem[] = [
    ...decisions.slice(1).map((entry): MenuItem => ({
      id: entry.kind,
      label: t(`action.${entry.kind}`),
      tone: entry.danger ? 'critical' : 'default',
      onSelect: () => decide(entry.kind),
    })),
    ...(hasLink ? [{ id: 'copy', label: t('action.copy-link'), onSelect: copyLink }] : []),
  ];

  const onCommented = (line: ActivityLine) =>
    setRequest((current) =>
      current === null
        ? current
        : {
            ...current,
            activity: [...current.activity, line],
            commentCount: current.commentCount + 1,
          },
    );

  return (
    <div className={`flex flex-col gap-4 ${!desktop && buttons.length > 0 ? 'pb-24' : ''}`}>
      {back}
      {refusal === null ? null : (
        <RefusalBanner
          refusal={refusal.refusal}
          reviewPermission={request.reviewPermission}
          onRetry={() => setDeciding(refusal.kind)}
        />
      )}
      {failure === 'unavailable' ? (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('error.unavailable')}</span>
            <Button variant="secondary" onClick={() => void load()}>
              {tl('retry')}
            </Button>
          </div>
        </Banner>
      ) : null}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="break-words text-2xl font-semibold text-fg">
              {request.displayNumber} {kindTitle(request.subjectKind)}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <AreaBadge area={request.area} />
              <RiskBadge risk={request.risk} />
              <StatusBadges request={request} />
            </div>
          </div>
          {desktop && (buttons.length > 0 || hasLink) ? (
            <ActionRow>
              {buttons}
              {hasLink ? (
                <IconButton icon="link" label={t('action.copy-link')} onClick={copyLink} />
              ) : null}
            </ActionRow>
          ) : null}
        </div>
        <DataList
          missing={t('none')}
          rows={[
            {
              label: t('detail.subject'),
              value:
                href === null ? (
                  <span className="break-words">{subjectName}</span>
                ) : (
                  <a className="break-words text-link underline" href={href}>
                    {subjectName}
                  </a>
                ),
            },
            {
              label: t('col.requestedBy'),
              value: person(request.requestedBy, request.requestedByName),
            },
            {
              label: t('col.applied'),
              value: formatInstantInZone(request.appliedAt, locale, zone),
            },
            {
              label: t('col.due'),
              value: (
                <span>
                  {dayInZone(request.reviewDueAt, locale, zone)}
                  {open && request.overdue ? (
                    <>
                      {' '}
                      <OverdueText request={request} zone={zone} />
                    </>
                  ) : null}
                </span>
              ),
            },
            ...(request.decidedBy === null
              ? []
              : [
                  {
                    label: t('col.decidedBy'),
                    value: person(request.decidedBy, request.decidedByName),
                  },
                  {
                    label: t('col.decided'),
                    value: formatInstantInZone(request.decidedAt, locale, zone),
                  },
                  { label: t('detail.reason'), value: request.decisionReason },
                ]),
          ]}
        />
      </Card>
      {open && !superseded ? <Banner tone="info">{t('banner.live')}</Banner> : null}
      {superseded ? (
        <Banner tone="attention">
          {t('banner.superseded')}{' '}
          <a className="font-medium underline" href={requestPath(request.supersededBy ?? '')}>
            {t('banner.see-later', {
              number:
                request.supersededByNumber === undefined || request.supersededByNumber === null
                  ? '?'
                  : request.supersededByNumber,
            })}
          </a>
        </Banner>
      ) : null}
      {open && mine ? <Banner tone="info">{t('banner.own')}</Banner> : null}
      {request.status === 'approved' ? (
        <p role="status" className="break-words text-sm text-fg-secondary">
          {t('outcome.approved', {
            name: who(request.decidedBy, request.decidedByName),
            date: decidedOn,
          })}
        </p>
      ) : null}
      {request.status === 'reverted' ? (
        <p role="status" className="break-words text-sm text-fg-secondary">
          {t(`outcome.${request.decision === 'withdrawn' ? 'withdrawn' : 'rejected'}`, {
            name: who(request.decidedBy, request.decidedByName),
            date: decidedOn,
            reason: request.decisionReason ?? '',
          })}
        </p>
      ) : null}
      <Card title={t('detail.note')}>
        <p className="whitespace-pre-wrap break-words text-fg-secondary">{request.note}</p>
      </Card>
      <ChangeDiff
        kind={request.subjectKind}
        before={request.before}
        after={request.after}
        history={!open || superseded}
      />
      <Activity
        requestId={request.id}
        lines={request.activity}
        accountId={accountId}
        csrfToken={csrfToken}
        zone={zone}
        onCommented={onCommented}
      />
      {!desktop && (buttons.length > 0 || hasLink) ? (
        <div className="fixed inset-x-0 bottom-0 z-10 flex items-center gap-2 border-t border-line bg-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex min-w-0 flex-1 [&>button]:w-full">{buttons[0] ?? null}</div>
          {overflow.length > 0 ? <Menu label={t('more-actions')} items={overflow} /> : null}
        </div>
      ) : null}
      <DecisionDialog
        kind={deciding}
        request={request}
        csrfToken={csrfToken}
        initialReason={refusal !== null && refusal.kind === deciding ? refusal.reason : ''}
        onClose={() => setDeciding(null)}
        onDecided={() => {
          setDeciding(null);
          setRefusal(null);
          void load();
        }}
        onRefused={(next, kind, reason) => {
          setDeciding(null);
          setRefusal({ refusal: next, kind, reason });
          // The request may have moved under the admin (decided, superseded): show what it is.
          if (next.refetch) void load();
        }}
      />
    </div>
  );
}
