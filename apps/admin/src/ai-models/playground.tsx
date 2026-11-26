'use client';

import { Badge, Banner, Button, Select, SettingsSection } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import {
  PLAYGROUND_PATH,
  PLAYGROUND_SAMPLES_PATH,
  playgroundAnswersOf,
  playgroundSuitesOf,
  type PlaygroundAnswer,
  type PlaygroundSuite,
} from './types.ts';

const MICRO = 1_000_000;
const dollars = (micro: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  }).format(micro / MICRO);

/** The message key (under `ai-models.playground.error`) for a failed run. */
function runProblemOf(failure: ApiFailure): string {
  if (failure.code === 'ai.playground-limit-reached' || failure.status === 429) {
    return failure.code === 'ai.playground-limit-reached' ? 'limit' : 'throttled';
  }
  if (failure.code === 'access.acting-as-refused') return 'acting-as';
  if (failure.code === 'access.denied') return 'denied';
  if (failure.code === 'request.csrf') return 'csrf';
  if (failure.code === 'validation.failed') return 'invalid';
  return failure.status === 0 || failure.status === 503 ? 'unavailable' : 'unknown';
}

/**
 * Settings › AI Models › Playground: runs one ready, synthetic sample of a capability on two
 * models side by side. The browser sends ids only (capability, sample, two families); the answer is
 * the capability's own guarded plain text, rendered as text. No two-step code: nothing is changed
 * or stored, and each admin has a small daily limit that the server enforces.
 */
export function AiPlayground({
  families,
  canRun,
  csrfToken,
}: {
  /** Families the server lists as usable here. */
  readonly families: readonly string[];
  readonly canRun: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('ai-models.playground');
  const [suites, setSuites] = useState<readonly PlaygroundSuite[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [capability, setCapability] = useState('');
  const [sampleId, setSampleId] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<readonly PlaygroundAnswer[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Each run takes a number; an answer is shown only while it is still the latest choice.
  const latest = useRef(0);

  useEffect(() => {
    let current = true;
    void callApi<unknown>('GET', PLAYGROUND_SAMPLES_PATH).then((result) => {
      if (!current) return;
      if (!result.ok && result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      const list = result.ok ? playgroundSuitesOf(result.body) : null;
      if (list === null) {
        setLoadFailed(true);
        return;
      }
      setSuites(list);
      const firstSuite = list[0];
      if (firstSuite !== undefined) {
        setCapability(firstSuite.capability);
        setSampleId(firstSuite.samples[0]?.id ?? '');
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const suite = suites?.find((item) => item.capability === capability) ?? null;
  const sample = suite?.samples.find((item) => item.id === sampleId) ?? null;
  const familyOptions = families.map((family) => ({ value: family, label: family }));
  const ready = sample !== null && first !== '' && second !== '' && first !== second;

  function choose(change: () => void) {
    latest.current += 1;
    setAnswers(null);
    setProblem(null);
    setBusy(false);
    change();
  }

  async function run() {
    if (!ready || !canRun || busy) return;
    const mine = ++latest.current;
    setBusy(true);
    setProblem(null);
    setAnswers(null);
    const result = await callApi<unknown>(
      'POST',
      PLAYGROUND_PATH,
      { capability, sampleId, families: [first, second] },
      csrfToken,
    );
    if (mine !== latest.current) return;
    setBusy(false);
    if (result.ok) {
      const shown = playgroundAnswersOf(result.body);
      if (shown === null) setProblem('unknown');
      else setAnswers(shown);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(runProblemOf(result.failure));
  }

  if (loadFailed) {
    return <Banner tone="critical">{t('load-failed')}</Banner>;
  }
  if (suites === null) {
    return <p className="text-sm text-fg-muted">{t('loading')}</p>;
  }
  if (suites.length === 0) {
    return (
      <SettingsSection title={t('section')} description={t('about')}>
        <p className="px-5 py-4 text-sm">{t('no-samples')}</p>
      </SettingsSection>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title={t('section')} description={t('about')}>
        <div className="flex flex-col gap-4 px-5 py-4">
          {canRun ? null : <Banner tone="info">{t('read-only')}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label={t('capability')}
              value={capability}
              onChange={(event) =>
                choose(() => {
                  const next = suites.find((item) => item.capability === event.target.value);
                  setCapability(event.target.value);
                  setSampleId(next?.samples[0]?.id ?? '');
                })
              }
              options={suites.map((item) => ({ value: item.capability, label: item.capability }))}
            />
            <Select
              label={t('sample')}
              value={sampleId}
              onChange={(event) => choose(() => setSampleId(event.target.value))}
              options={(suite?.samples ?? []).map((item) => ({
                value: item.id,
                label: item.label,
              }))}
            />
            <Select
              label={t('model-a')}
              value={first}
              placeholder={t('choose')}
              onChange={(event) => choose(() => setFirst(event.target.value))}
              options={familyOptions}
            />
            <Select
              label={t('model-b')}
              value={second}
              placeholder={t('choose')}
              onChange={(event) => choose(() => setSecond(event.target.value))}
              options={familyOptions.filter((option) => option.value !== first)}
            />
          </div>
          {families.length < 2 ? <p className="text-sm">{t('few-models')}</p> : null}
          <p className="text-sm text-fg-muted">{t('cost-note')}</p>
          <div>
            <Button disabled={!canRun || !ready || busy} onClick={() => void run()}>
              {busy ? t('running') : t('run')}
            </Button>
          </div>
          {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
        </div>
      </SettingsSection>
      {answers === null ? null : (
        <div className="grid gap-4 md:grid-cols-2" aria-live="polite">
          {answers.map((answer) => (
            <SettingsSection key={answer.family} title={answer.family}>
              <div className="flex flex-col gap-3 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={answer.outcome === 'ok' ? 'success' : 'attention'}>
                    {t(`outcome.${answer.outcome}`)}
                  </Badge>
                  {answer.checks.map((check) => (
                    <Badge key={check} tone="attention">
                      {t(`check.${check}`)}
                    </Badge>
                  ))}
                  {answer.outcome === 'ok' && answer.checks.length === 0 ? (
                    <Badge tone="success">{t('checks-clean')}</Badge>
                  ) : null}
                </div>
                {answer.text === null ? (
                  <p className="text-sm">{t('no-text')}</p>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm">{answer.text}</p>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-fg-muted">{t('cost')}</dt>
                  <dd>{dollars(answer.costMicroUsd)}</dd>
                  <dt className="text-fg-muted">{t('latency')}</dt>
                  <dd>{answer.latencyMs === null ? '-' : `${answer.latencyMs} ms`}</dd>
                  <dt className="text-fg-muted">{t('route')}</dt>
                  <dd>{answer.route ?? '-'}</dd>
                </dl>
              </div>
            </SettingsSection>
          ))}
        </div>
      )}
    </div>
  );
}
