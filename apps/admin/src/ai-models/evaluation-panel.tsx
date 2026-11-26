'use client';

import { Badge, Banner, Button, Select, SettingsSection, type BadgeTone } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { gatewayProblemOf } from '../ai-gateway/errors.ts';
import { formatInstant } from '../shared/format.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import {
  EVALUATIONS_PATH,
  EVALUATION_ESTIMATE_PATH,
  EVALUATION_PROVIDER,
  OPEN_STATUSES,
  detailOf,
  dollars,
  estimateOf,
  evaluationCancelPath,
  evaluationPath,
  runListOf,
  type EvaluationDetail,
  type EvaluationEstimate,
  type EvaluationRun,
} from './evaluation-types.ts';

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  queued: 'neutral',
  running: 'info',
  completed: 'neutral',
  cancelled: 'neutral',
  'closed-budget': 'attention',
  'closed-saver': 'attention',
  'closed-off': 'attention',
};
const VERDICT_TONE: Readonly<Record<string, BadgeTone>> = {
  'pass-candidate': 'info',
  failed: 'critical',
  incomplete: 'attention',
  pending: 'neutral',
  superseded: 'neutral',
};

const VERDICT_ORDER = ['failed', 'incomplete', 'pending', 'pass-candidate', 'superseded'];

/** The worst verdict of a run's capabilities: one failure makes the run failed. */
function overallOf(items: readonly { readonly verdict: string }[]): string {
  for (const verdict of VERDICT_ORDER) {
    if (items.some((item) => item.verdict === verdict)) return verdict;
  }
  return 'pending';
}

/** Message keys of a refused run: one line per blocker, and the stale estimate. */
function fieldLines(
  failure: ApiFailure,
  t: (key: string) => string,
): { readonly stale: boolean; readonly lines: readonly string[] } {
  const fields = failure.details?.fields ?? [];
  const stale = fields.some((field) => field.path === 'expectedEstimateMicroUsd');
  const lines = fields
    .filter((field) => field.path === 'family')
    .map((field) => t(`blocker.${field.code}`));
  return { stale, lines };
}

/**
 * Settings › AI Models › Evaluation: the cost estimate of an evaluation run of one model, the run
 * itself (always behind the two-step code), the runs of the Market and one run's result. A result
 * is only a pass candidate; a pull request records a pass. No model text is stored or shown.
 */
export function EvaluationPanel({
  families,
  canManage,
  csrfToken,
}: {
  readonly families: readonly string[];
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('ai-models.evaluation');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [family, setFamily] = useState('');
  const [estimate, setEstimate] = useState<EvaluationEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const [runs, setRuns] = useState<readonly EvaluationRun[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  // True when a write went through but the list could not be read again.
  const [stale, setStale] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvaluationDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [started, setStarted] = useState(false);
  // The answer a screen waits for is the last one asked; a slow older answer is dropped.
  const estimateWanted = useRef('');
  const runsWanted = useRef(0);
  const detailWanted = useRef<string | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // What the admin has chosen now, for reads that follow a write (never a value captured earlier).
  const filterRef = useRef('');
  // A write went through and no list read since has succeeded.
  const unreadWrite = useRef(false);
  const focusDetail = useRef(false);

  /** True: read; false: failed; null: a newer read took over, so this answer says nothing. */
  async function loadRuns(from: string | null, wantedFilter: string): Promise<boolean | null> {
    const ticket = ++runsWanted.current;
    const query = new URLSearchParams();
    if (wantedFilter !== '') query.set('family', wantedFilter);
    if (from !== null) query.set('cursor', from);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    const result = await callApi<unknown>('GET', `${EVALUATIONS_PATH}${suffix}`);
    if (!result.ok && result.failure.status === 401) {
      window.location.assign('/session-ended');
      return false;
    }
    if (runsWanted.current !== ticket) return null;
    const page = result.ok ? runListOf(result.body) : null;
    if (page === null) {
      setRunsFailed(true);
      if (unreadWrite.current) setStale(true);
      return false;
    }
    setRunsFailed(false);
    if (from === null) {
      unreadWrite.current = false;
      setStale(false);
    }
    setRuns((current) =>
      from === null || current === null ? page.runs : [...current, ...page.runs],
    );
    setNext(page.next);
    return true;
  }

  useEffect(() => {
    void loadRuns(null, '');
    // Read once when the tab opens; later reads follow the admin's own actions.
  }, []);

  /** `quiet`: read again what is open, keeping the old result in view meanwhile. */
  async function loadDetail(runId: string, quiet = false) {
    detailWanted.current = runId;
    setOpenId(runId);
    if (!quiet) {
      setDetail(null);
      focusDetail.current = true;
    }
    setDetailFailed(false);
    const result = await callApi<unknown>('GET', evaluationPath(runId));
    if (!result.ok && result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (detailWanted.current !== runId) return;
    const read = result.ok ? detailOf(result.body) : null;
    if (read === null) setDetailFailed(true);
    else setDetail(read);
  }

  // The opened run comes into view and takes the focus, next to the button that opened it.
  useEffect(() => {
    if (openId === null || !focusDetail.current) return;
    focusDetail.current = false;
    const node = detailRef.current;
    if (node === null) return;
    node.scrollIntoView?.({ block: 'nearest' });
    node.focus({ preventScroll: true });
  }, [openId, detail]);

  async function loadEstimate(chosen: string) {
    estimateWanted.current = chosen;
    setEstimate(null);
    setEstimateFailed(false);
    if (chosen === '') {
      setEstimating(false);
      return;
    }
    setEstimating(true);
    const query = new URLSearchParams({ provider: EVALUATION_PROVIDER, family: chosen });
    const result = await callApi<unknown>('GET', `${EVALUATION_ESTIMATE_PATH}?${query.toString()}`);
    if (!result.ok && result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    // A slow answer for a model the admin has moved away from must not show under another one.
    if (estimateWanted.current !== chosen) return;
    const read = result.ok ? estimateOf(result.body) : null;
    if (read === null) setEstimateFailed(true);
    else setEstimate(read);
    setEstimating(false);
  }

  async function afterWrite() {
    unreadWrite.current = true;
    // A read of a newer filter may take over (null): it clears or sets the stale mark itself.
    await loadRuns(null, filterRef.current);
    if (openId !== null) void loadDetail(openId, true);
  }

  async function run() {
    if (busy || estimate === null || estimate.blockers.length > 0) return;
    setBusy(true);
    setProblem(null);
    setLines([]);
    setStarted(false);
    const result = await guarded<unknown>(
      'POST',
      EVALUATIONS_PATH,
      {
        provider: estimate.provider,
        family: estimate.family,
        expectedEstimateMicroUsd: estimate.estimateMicroUsd,
      },
      csrfToken,
    );
    if (result.ok) {
      setStarted(true);
      await afterWrite();
      await loadEstimate(estimate.family);
    } else if (!isStepUpCancelled(result)) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else {
        const found = fieldLines(result.failure, t);
        setLines(found.lines);
        if (found.stale) {
          setProblem('stale');
          await loadEstimate(estimate.family);
        } else if (found.lines.length > 0) {
          setProblem('blocked');
          await loadEstimate(estimate.family);
        } else {
          setProblem(gatewayProblemOf(result.failure));
        }
      }
    }
    setBusy(false);
  }

  async function cancel(runId: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setLines([]);
    setStarted(false);
    const result = await callApi<unknown>(
      'POST',
      evaluationCancelPath(runId),
      undefined,
      csrfToken,
    );
    if (result.ok) {
      await afterWrite();
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      // A run that already ended is "not found" here: show the list as it is now.
      setProblem(
        result.failure.code === 'ai.evaluation-not-found'
          ? 'gone'
          : gatewayProblemOf(result.failure),
      );
      await afterWrite();
    }
    setBusy(false);
  }

  const disabled = busy || stale;
  const microText = (micro: number) => t('money', { amount: dollars(micro) });
  const blocked = estimate !== null && estimate.blockers.length > 0;
  const hasOpenRun = runs?.some((item) => OPEN_STATUSES.includes(item.status)) ?? false;

  const detailView = (
    <div
      ref={detailRef}
      tabIndex={-1}
      aria-label={t('detail.section')}
      className="flex flex-col gap-4 rounded-md border border-line px-4 py-3 outline-none focus-visible:ring-2"
    >
      {detailFailed ? <Banner tone="critical">{t('detail.failed')}</Banner> : null}
      {detail === null && !detailFailed ? <p className="text-sm">{t('detail.loading')}</p> : null}
      {detail === null ? null : (
        <>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{detail.run.family}</span>
            <Badge tone={STATUS_TONE[detail.run.status] ?? 'neutral'}>
              {t(`status.${detail.run.status}`)}
            </Badge>
            <Badge tone={VERDICT_TONE[overallOf(detail.capabilities)] ?? 'neutral'}>
              {t('detail.overall', { verdict: t(`verdict.${overallOf(detail.capabilities)}`) })}
            </Badge>
            <span className="text-fg-muted">
              {t('detail.spent', { amount: dollars(detail.costMicroUsd) })}
            </span>
          </p>
          {detail.run.status.startsWith('closed-') ? (
            <Banner tone="attention">{t(`detail.closed.${detail.run.status}`)}</Banner>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <caption className="sr-only">{t('detail.verdicts')}</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="py-2 pe-4 text-start font-medium">
                    {t('col.capability')}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-start font-medium">
                    {t('col.samples')}
                  </th>
                  <th scope="col" className="py-2 text-start font-medium">
                    {t('col.verdict')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.capabilities.map((item) => (
                  <tr key={item.capability} className="border-b border-line">
                    <th scope="row" className="py-2 pe-4 text-start font-normal">
                      {item.capability}
                      <span className="block text-xs text-fg-muted">
                        {t('versions', { prompt: item.promptVersion, set: item.setVersion })}
                      </span>
                    </th>
                    <td className="py-2 pe-4">{item.samplesTotal}</td>
                    <td className="py-2">
                      <Badge tone={VERDICT_TONE[item.verdict] ?? 'neutral'}>
                        {t(`verdict.${item.verdict}`)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail.samples.length === 0 ? (
            <p className="text-sm">{t('detail.no-samples')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <caption className="sr-only">{t('detail.samples')}</caption>
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className="py-2 pe-4 text-start font-medium">
                      {t('col.sample')}
                    </th>
                    <th scope="col" className="py-2 pe-4 text-start font-medium">
                      {t('col.outcome')}
                    </th>
                    <th scope="col" className="py-2 pe-4 text-start font-medium">
                      {t('col.checks')}
                    </th>
                    <th scope="col" className="py-2 pe-4 text-start font-medium">
                      {t('col.tokens')}
                    </th>
                    <th scope="col" className="py-2 pe-4 text-start font-medium">
                      {t('col.cost')}
                    </th>
                    <th scope="col" className="py-2 text-start font-medium">
                      {t('col.latency')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.samples.map((item) => (
                    <tr
                      key={`${item.capability}-${item.sampleId}`}
                      className="border-b border-line"
                    >
                      <th scope="row" className="py-2 pe-4 text-start font-normal">
                        {item.sampleId}
                        <span className="block text-xs text-fg-muted">{item.capability}</span>
                      </th>
                      <td className="py-2 pe-4">{t(`outcome.${item.outcome}`)}</td>
                      <td className="py-2 pe-4">
                        {item.checks.length === 0
                          ? t('check.none')
                          : item.checks.map((check) => t(`check.${check}`)).join(', ')}
                      </td>
                      <td className="py-2 pe-4">{item.inputTokens + item.outputTokens}</td>
                      <td className="py-2 pe-4">{microText(item.costMicroUsd)}</td>
                      <td className="py-2">
                        {item.latencyMs === null
                          ? t('check.none')
                          : t('ms', { ms: item.latencyMs })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      id="ai-models-panel"
      role="tabpanel"
      aria-labelledby="ai-models-panel-tab-evaluation"
      className="flex flex-col gap-6"
    >
      <Banner tone="info">{t('candidate-note')}</Banner>
      {stale ? <Banner tone="critical">{t('error.refresh')}</Banner> : null}
      {problem === null ? null : (
        <Banner tone={problem === 'stale' || problem === 'gone' ? 'attention' : 'critical'}>
          <p>{t(`error.${problem}`)}</p>
          {lines.length === 0 ? null : (
            <ul className="list-disc ps-5">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      {started ? <Banner tone="success">{t('started')}</Banner> : null}

      <SettingsSection title={t('estimate.section')} description={t('estimate.intro')}>
        <div className="flex flex-col gap-4 px-5 py-4">
          <Select
            label={t('estimate.model')}
            placeholder={t('estimate.choose')}
            options={families.map((item) => ({ value: item, label: item }))}
            value={family}
            onChange={(event) => {
              setFamily(event.target.value);
              setStarted(false);
              setProblem(null);
              setLines([]);
              void loadEstimate(event.target.value);
            }}
          />
          {estimating ? <p className="text-sm">{t('estimate.loading')}</p> : null}
          {estimateFailed ? <Banner tone="critical">{t('estimate.failed')}</Banner> : null}
          {estimate === null ? null : (
            <>
              {blocked ? (
                <Banner tone="attention" title={t('estimate.blocked')}>
                  <ul className="list-disc ps-5">
                    {estimate.blockers.map((code) => (
                      <li key={code}>{t(`blocker.${code}`)}</li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
              {estimate.capabilities.length === 0 ? (
                <p className="text-sm">{t('estimate.none')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-start text-sm">
                    <caption className="sr-only">
                      {t('estimate.table', { family: estimate.family })}
                    </caption>
                    <thead>
                      <tr className="border-b border-line">
                        <th scope="col" className="py-2 pe-4 text-start font-medium">
                          {t('col.capability')}
                        </th>
                        <th scope="col" className="py-2 pe-4 text-start font-medium">
                          {t('col.samples')}
                        </th>
                        <th scope="col" className="py-2 text-start font-medium">
                          {t('col.estimate')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {estimate.capabilities.map((item) => (
                        <tr key={item.capability} className="border-b border-line">
                          <th scope="row" className="py-2 pe-4 text-start font-normal">
                            {item.capability}
                            <span className="block text-xs text-fg-muted">
                              {t('versions', { prompt: item.promptVersion, set: item.setVersion })}
                            </span>
                          </th>
                          <td className="py-2 pe-4">{item.samples}</td>
                          <td className="py-2">{microText(item.estimateMicroUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-sm">
                <span className="font-medium">{t('estimate.total')}</span>{' '}
                {microText(estimate.estimateMicroUsd)}
                {' · '}
                {t('estimate.budget-left', { amount: dollars(estimate.budgetLeftMicroUsd) })}
              </p>
              {canManage ? (
                <div className="flex flex-col gap-2">
                  <div>
                    <Button
                      disabled={disabled || blocked || estimate.capabilities.length === 0}
                      onClick={() => void run()}
                    >
                      {t('estimate.run')}
                    </Button>
                  </div>
                  <p className="text-sm text-fg-muted">{t('estimate.run-help')}</p>
                </div>
              ) : (
                <Banner tone="info">{t('read-only')}</Banner>
              )}
            </>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title={t('runs.section')} description={t('runs.intro')}>
        <div className="flex flex-col gap-4 px-5 py-4">
          <Select
            label={t('runs.filter')}
            placeholder={t('runs.all')}
            options={families.map((item) => ({ value: item, label: item }))}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              filterRef.current = event.target.value;
              setRuns(null);
              setNext(null);
              void loadRuns(null, event.target.value);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void loadRuns(null, filterRef.current)}
            >
              {t('runs.refresh')}
            </Button>
            {hasOpenRun ? (
              <span className="text-sm text-fg-muted">{t('runs.open-hint')}</span>
            ) : null}
          </div>
          {runsFailed ? <Banner tone="critical">{t('runs.failed')}</Banner> : null}
          {runs !== null && runs.length === 0 && !runsFailed ? (
            <p className="text-sm">{t('runs.empty')}</p>
          ) : null}
          {runs !== null && runs.length > 0 ? (
            <ul className="flex flex-col divide-y divide-line" aria-label={t('runs.list')}>
              {runs.map((item) => (
                <li key={item.id} className="flex flex-col gap-3 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="flex-1 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.family}</span>
                        <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>
                          {t(`status.${item.status}`)}
                        </Badge>
                      </p>
                      <p className="break-words text-fg-muted">
                        {t('runs.when', {
                          when: formatInstant(item.requestedAt, locale),
                          amount: dollars(item.estimateMicroUsd),
                        })}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        aria-label={t('runs.details-of', { family: item.family })}
                        onClick={() => void loadDetail(item.id)}
                      >
                        {t('runs.details')}
                      </Button>
                      {canManage && OPEN_STATUSES.includes(item.status) ? (
                        <Button
                          variant="secondary"
                          disabled={disabled}
                          aria-label={t('runs.cancel-of', { family: item.family })}
                          onClick={() => void cancel(item.id)}
                        >
                          {t('runs.cancel')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {openId === item.id ? detailView : null}
                </li>
              ))}
            </ul>
          ) : null}
          {next === null ? null : (
            <div>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void loadRuns(next, filterRef.current)}
              >
                {t('runs.more')}
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
