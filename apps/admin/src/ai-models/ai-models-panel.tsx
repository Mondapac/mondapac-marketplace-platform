'use client';

import {
  Badge,
  Banner,
  Button,
  Dialog,
  Select,
  SettingsPage,
  SettingsSection,
  TextAreaField,
  TextField,
  Tabs,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { gatewayProblemOf } from '../ai-gateway/errors.ts';
import { find, historyOf, type GatewaySetting, type HistoryEntry } from '../ai-gateway/types.ts';
import { formatInstant } from '../shared/format.ts';
import { REVIEW_NOTE_MAX, isNoteFailure, useSentForReview } from '../shared/review-note.tsx';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { EvaluationPanel } from './evaluation-panel.tsx';
import { familiesOfOptions } from './evaluation-types.ts';
import {
  DEFAULT_SAVER_PERCENT,
  MAX_FAMILIES,
  MODELS_HISTORY_PATH,
  MODELS_PATH,
  MODELS_REVERT_PATH,
  MODEL_CODES,
  SAVER_PERCENT_CODE,
  TASKS,
  familiesOf,
  listCode,
  modelsAnswerOf,
  moved,
  saverCode,
  valueOfFamilies,
  type ModelsAnswer,
  type Task,
} from './types.ts';

interface Draft {
  readonly lists: Readonly<Record<Task, readonly string[]>>;
  readonly savers: Readonly<Record<Task, string>>;
  readonly percent: string;
}

const savedDraft = (rows: readonly GatewaySetting[]): Draft => ({
  lists: Object.fromEntries(
    TASKS.map((task) => [task, familiesOf(find(rows, listCode(task)).value)]),
  ) as Record<Task, readonly string[]>,
  savers: Object.fromEntries(
    TASKS.map((task) => [task, familiesOf(find(rows, saverCode(task)).value)[0] ?? '']),
  ) as Record<Task, string>,
  percent: find(rows, SAVER_PERCENT_CODE).value || DEFAULT_SAVER_PERCENT,
});

/** "Chat, model 2: Retired" lines for the fields of a refused save (path `<code>` or `<code>.<index>`). */
function fieldProblemsOf(
  fields: readonly { readonly path: string; readonly code: string }[],
  t: (key: string, values?: Record<string, string | number>) => string,
): readonly string[] {
  const lines: string[] = [];
  for (const field of fields) {
    const [code = '', index] = field.path.split('.');
    const task = TASKS.find((item) => code === listCode(item) || code === saverCode(item));
    if (task === undefined) continue;
    const where =
      code === saverCode(task)
        ? t('field.saver', { task: t(`task.${task}.label`) })
        : t('field.model', { task: t(`task.${task}.label`), n: Number(index ?? 0) + 1 });
    lines.push(`${where}: ${t(`problem.${field.code}`)}`);
  }
  return lines;
}

interface Change {
  readonly code: string;
  readonly value: string;
  readonly before: string;
}

/** What differs between the saved page and the draft, as the API would take it. */
function changesOf(rows: readonly GatewaySetting[], draft: Draft): readonly Change[] {
  const out: Change[] = [];
  const push = (code: string, value: string, fallback: string) => {
    const saved = find(rows, code).value || fallback;
    if (saved !== value) out.push({ code, value, before: saved });
  };
  for (const task of TASKS) {
    push(listCode(task), valueOfFamilies(draft.lists[task]), 'none');
    push(saverCode(task), draft.savers[task] === '' ? 'none' : draft.savers[task], 'none');
  }
  push(SAVER_PERCENT_CODE, draft.percent.trim(), DEFAULT_SAVER_PERCENT);
  return out;
}

/**
 * Settings › AI Models › External models: per task type the models to try in order (at most three,
 * chosen only among the families the server lists as usable here), a cheaper saver model that goes
 * first from the saver threshold, and that threshold. Before saving, a preview lists each change;
 * saving always asks for the two-step code. The own-model tab is a placeholder until G6.
 */
export function AiModelsPanel({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: ModelsAnswer;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('ai-models');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const sentForReview = useSentForReview();
  const [answer, setAnswer] = useState(initial);
  const [draft, setDraft] = useState(() => savedDraft(initial.settings));
  const [tab, setTab] = useState<'external' | 'evaluation' | 'own'>('external');
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  // True when a save went through but the page could not refresh: nothing more is saved from stale values.
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldProblems, setFieldProblems] = useState<readonly string[]>([]);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [percentError, setPercentError] = useState(false);
  const [historyCode, setHistoryCode] = useState(MODEL_CODES[0] ?? '');
  const [history, setHistory] = useState<readonly HistoryEntry[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const historyWanted = useRef<string>(MODEL_CODES[0] ?? '');

  const rows = answer.settings;
  const changes = changesOf(rows, draft);
  const reviewed = rows.some((row) => row.review?.reviewed === true);
  const optionsOf = (task: Task) => answer.options[task] ?? [];
  const problemOf = (task: Task, family: string): string | null =>
    optionsOf(task).find((option) => option.family === family)?.problem ?? 'unknown-model';

  // A saved model that can no longer be used (retired, key gone, not evaluated): the admin sees
  // it before the gateway skips it.
  const alerts = TASKS.flatMap((task) =>
    [
      ...familiesOf(find(rows, listCode(task)).value),
      ...familiesOf(find(rows, saverCode(task)).value),
    ]
      .map((family) => ({ task, family, why: problemOf(task, family) }))
      .filter((item) => item.why !== null),
  );

  async function reload(): Promise<boolean> {
    const fresh = await callApi<unknown>('GET', MODELS_PATH);
    if (!fresh.ok && fresh.failure.status === 401) {
      window.location.assign('/session-ended');
      return false;
    }
    const next = fresh.ok ? modelsAnswerOf(fresh.body) : null;
    if (next === null) return false;
    setAnswer(next);
    setDraft(savedDraft(next.settings));
    return true;
  }

  async function write(method: 'PUT' | 'POST', path: string, body: unknown): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setProblem(null);
    setFieldProblems([]);
    setNoteError(null);
    const result = await guarded<unknown>(method, path, body, csrfToken);
    if (result.ok) {
      const fresh = await reload();
      if (!fresh) {
        setProblem('refresh');
        setStale(true);
      }
      setNote('');
      if (history !== null && path === MODELS_PATH) void loadHistory(historyCode);
      toast.success(t('saved'));
      sentForReview(result.body);
      setBusy(false);
      return true;
    }
    if (!isStepUpCancelled(result)) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else if (isNoteFailure(result.failure)) {
        const missing = (result.failure.details?.fields ?? []).some(
          (field) => field.path === 'note' && field.code === 'required',
        );
        setNoteError(missing ? 'required' : 'rejected');
      } else {
        const key = gatewayProblemOf(result.failure);
        setProblem(key);
        if (key === 'conflict' && !(await reload())) {
          setProblem('refresh');
          setStale(true);
        }
        setFieldProblems(fieldProblemsOf(result.failure.details?.fields ?? [], t));
      }
    }
    setBusy(false);
    return false;
  }

  function openPreview() {
    const percent = Number(draft.percent);
    if (!/^\d{2}$/.test(draft.percent.trim()) || percent < 50 || percent > 99) {
      setPercentError(true);
      return;
    }
    setPercentError(false);
    if (reviewed && note.trim() === '') {
      setNoteError('required');
      return;
    }
    setPreviewing(true);
  }

  async function save() {
    await write('PUT', MODELS_PATH, {
      changes: changes.map((change) => ({
        code: change.code,
        value: change.value,
        expectedVersion: find(rows, change.code).version,
      })),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    setPreviewing(false);
  }

  async function loadHistory(code: string) {
    historyWanted.current = code;
    setHistoryCode(code);
    setHistory(null);
    setHistoryFailed(false);
    const result = await callApi<unknown>(
      'GET',
      `${MODELS_HISTORY_PATH}?code=${encodeURIComponent(code)}`,
    );
    if (!result.ok && result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    // A slow answer for a setting the admin has moved away from must not show under another one.
    if (historyWanted.current !== code) return;
    const entries = result.ok ? historyOf(result.body) : null;
    if (entries === null) setHistoryFailed(true);
    else setHistory(entries);
  }

  /** Restores what the admin sees in one history row (`version` 0 is the default). */
  async function restore(code: string, version: number) {
    if (reviewed && note.trim() === '') {
      setNoteError('required');
      return;
    }
    const saved = await write('POST', MODELS_REVERT_PATH, {
      code,
      version,
      expectedVersion: find(rows, code).version,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    if (saved || historyWanted.current === code) await loadHistory(code);
  }

  const setList = (task: Task, list: readonly string[]) =>
    setDraft((current) => ({
      ...current,
      lists: { ...current.lists, [task]: list },
      // A saver needs a list: an emptied list drops it.
      // A saver needs a list, and is never the first model of it.
      savers: {
        ...current.savers,
        [task]: list.length === 0 || current.savers[task] === list[0] ? '' : current.savers[task],
      },
    }));
  const disabled = !canManage || busy || stale;
  const dirty = changes.length > 0;
  const taskLabel = (task: Task) => t(`task.${task}.label`);
  const shown = (value: string | null) =>
    value === null ? t('history.default') : value === 'none' ? t('none') : value;

  const banners = [
    alerts.length === 0 ? null : (
      <Banner key="alerts" tone="attention" title={t('alerts.title')}>
        <ul className="list-disc ps-5">
          {alerts.map((item) => (
            <li key={`${item.task}-${item.family}`}>
              {t('alerts.item', {
                family: item.family,
                task: taskLabel(item.task),
                why: t(`problem.${item.why ?? 'unknown-model'}`),
              })}
            </li>
          ))}
        </ul>
      </Banner>
    ),
    canManage ? null : (
      <Banner key="read-only" tone="info">
        {t('read-only')}
      </Banner>
    ),
    problem === null ? null : (
      <Banner key="problem" tone={problem === 'conflict' ? 'attention' : 'critical'}>
        <p>{t(`error.${problem}`)}</p>
        {fieldProblems.length === 0 ? null : (
          <ul className="list-disc ps-5">
            {fieldProblems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </Banner>
    ),
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={t('title')}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
    >
      <Tabs
        label={t('tabs.label')}
        panelId="ai-models-panel"
        activeId={tab}
        onSelect={(id) =>
          setTab(id === 'own' ? 'own' : id === 'evaluation' ? 'evaluation' : 'external')
        }
        items={[
          { id: 'external', label: t('tabs.external') },
          { id: 'evaluation', label: t('tabs.evaluation') },
          { id: 'own', label: t('tabs.own') },
        ]}
      />
      {tab === 'evaluation' ? (
        <EvaluationPanel
          families={familiesOfOptions(answer.options)}
          canManage={canManage}
          csrfToken={csrfToken}
        />
      ) : tab === 'own' ? (
        <div id="ai-models-panel" role="tabpanel" aria-labelledby="ai-models-panel-tab-own">
          <SettingsSection title={t('own.section')} description={t('own.body')}>
            <p className="px-5 py-4 text-sm">{t('own.later')}</p>
          </SettingsSection>
        </div>
      ) : (
        <div
          id="ai-models-panel"
          role="tabpanel"
          aria-labelledby="ai-models-panel-tab-external"
          className="flex flex-col gap-6"
        >
          {TASKS.map((task) => {
            const list = draft.lists[task];
            const free = optionsOf(task).filter(
              (option) => option.problem === null && !list.includes(option.family),
            );
            const saverChoices = optionsOf(task).filter(
              (option) => option.problem === null && option.family !== list[0],
            );
            const savedSaver = draft.savers[task];
            // A chosen saver the server no longer lists as usable stays visible, with its problem.
            const saverOptions =
              savedSaver === '' || saverChoices.some((option) => option.family === savedSaver)
                ? saverChoices.map((option) => ({ value: option.family, label: option.family }))
                : [
                    ...saverChoices.map((option) => ({
                      value: option.family,
                      label: option.family,
                    })),
                    {
                      value: savedSaver,
                      label: `${savedSaver} (${t(`problem.${problemOf(task, savedSaver) ?? 'unknown-model'}`)})`,
                    },
                  ];
            return (
              <SettingsSection
                key={task}
                title={taskLabel(task)}
                description={t(`task.${task}.about`)}
              >
                <div className="flex flex-col gap-4 px-5 py-4">
                  {list.length === 0 ? (
                    <p className="text-sm">{t('list.empty')}</p>
                  ) : (
                    <ol
                      className="flex flex-col gap-2"
                      aria-label={t('list.label', { task: taskLabel(task) })}
                    >
                      {list.map((family, index) => {
                        const why = problemOf(task, family);
                        return (
                          <li
                            key={family}
                            className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2"
                          >
                            <span className="w-6 text-fg-muted">{index + 1}.</span>
                            <span className="flex-1 font-medium">{family}</span>
                            {why === null ? null : (
                              <Badge tone="attention">{t(`problem.${why}`)}</Badge>
                            )}
                            {canManage ? (
                              <>
                                <Button
                                  variant="secondary"
                                  disabled={disabled || index === 0}
                                  aria-label={t('list.up', { family })}
                                  onClick={() => setList(task, moved(list, index, -1))}
                                >
                                  {t('list.up-short')}
                                </Button>
                                <Button
                                  variant="secondary"
                                  disabled={disabled || index === list.length - 1}
                                  aria-label={t('list.down', { family })}
                                  onClick={() => setList(task, moved(list, index, 1))}
                                >
                                  {t('list.down-short')}
                                </Button>
                                <Button
                                  variant="secondary"
                                  disabled={disabled}
                                  aria-label={t('list.remove', { family })}
                                  onClick={() =>
                                    setList(
                                      task,
                                      list.filter((item) => item !== family),
                                    )
                                  }
                                >
                                  {t('list.remove-short')}
                                </Button>
                              </>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {canManage && list.length < MAX_FAMILIES ? (
                    <Select
                      label={t('list.add', { task: taskLabel(task) })}
                      placeholder={t('list.choose')}
                      help={t('list.add-help', { max: MAX_FAMILIES })}
                      options={free.map((option) => ({
                        value: option.family,
                        label: option.family,
                      }))}
                      value=""
                      error={free.length === 0 ? t('list.none-usable') : undefined}
                      disabled={disabled || free.length === 0}
                      onChange={(event) => {
                        if (event.target.value !== '') setList(task, [...list, event.target.value]);
                      }}
                    />
                  ) : null}
                  <Select
                    label={t('saver.label', { task: taskLabel(task) })}
                    placeholder={t('saver.none')}
                    help={t('saver.help')}
                    options={saverOptions}
                    value={draft.savers[task]}
                    disabled={disabled || list.length === 0}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        savers: { ...current.savers, [task]: event.target.value },
                      }))
                    }
                  />
                </div>
              </SettingsSection>
            );
          })}

          <SettingsSection title={t('percent.section')} description={t('percent.intro')}>
            <div className="px-5 py-4">
              <TextField
                label={t('percent.label')}
                help={t('percent.help')}
                inputMode="numeric"
                value={draft.percent}
                disabled={disabled}
                error={percentError ? t('percent.invalid') : undefined}
                onChange={(event) => {
                  setPercentError(false);
                  setDraft((current) => ({ ...current, percent: event.target.value }));
                }}
              />
            </div>
          </SettingsSection>

          {canManage ? (
            <SettingsSection title={t('save.section')} description={t('save.intro')}>
              <div className="flex flex-col gap-4 px-5 py-4">
                <TextAreaField
                  label={t('note.label')}
                  help={t('note.help', { max: REVIEW_NOTE_MAX })}
                  error={noteError === null ? undefined : t(`note.error.${noteError}`)}
                  rows={2}
                  value={note}
                  maxLength={REVIEW_NOTE_MAX}
                  disabled={busy}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setNoteError(null);
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button disabled={disabled || changes.length === 0} onClick={openPreview}>
                    {t('save.review')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || changes.length === 0}
                    onClick={() => setDraft(savedDraft(rows))}
                  >
                    {t('save.discard')}
                  </Button>
                </div>
              </div>
            </SettingsSection>
          ) : null}

          <SettingsSection title={t('history.section')} description={t('history.intro')}>
            <div className="flex flex-col gap-4 px-5 py-4">
              <Select
                label={t('history.setting')}
                options={MODEL_CODES.map((code) => ({ value: code, label: t(`code.${code}`) }))}
                value={historyCode}
                onChange={(event) => {
                  historyWanted.current = event.target.value;
                  setHistory(null);
                  setHistoryFailed(false);
                  setHistoryCode(event.target.value);
                }}
              />
              <div>
                <Button variant="secondary" onClick={() => void loadHistory(historyCode)}>
                  {t('history.show')}
                </Button>
              </div>
              {historyFailed ? <Banner tone="critical">{t('history.failed')}</Banner> : null}
              {history !== null && history.length === 0 ? (
                <p className="text-sm">{t('history.empty')}</p>
              ) : null}
              {history !== null && history.length > 0 ? (
                <ul className="flex flex-col divide-y divide-line" aria-label={t('history.list')}>
                  {history.map((entry) => (
                    <li
                      key={entry.version}
                      className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center"
                    >
                      <div className="flex-1 text-sm">
                        <p>
                          {t('history.change', {
                            version: entry.version,
                            before: shown(entry.previousValue),
                            after: shown(entry.value),
                          })}
                          {entry.current ? <Badge tone="info">{t('history.current')}</Badge> : null}
                        </p>
                        <p className="break-words text-fg-muted">
                          {t('history.by-at', {
                            name: entry.changedBy ?? t('history.unknown'),
                            when: formatInstant(entry.changedAt, locale),
                          })}
                          {entry.note === null ? '' : ` · ${entry.note}`}
                        </p>
                      </div>
                      {canManage && !entry.current ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            disabled={disabled || dirty}
                            aria-label={t('history.restore-value', {
                              version: entry.version,
                              value: shown(entry.value),
                            })}
                            onClick={() => void restore(entry.code, entry.version)}
                          >
                            {t('history.restore', { version: entry.version })}
                          </Button>
                          {entry.previousValue === null ? (
                            <Button
                              variant="secondary"
                              disabled={disabled || dirty}
                              onClick={() => void restore(entry.code, 0)}
                            >
                              {t('history.restore-default')}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {history !== null && history.length >= 50 ? (
                <p className="text-sm text-fg-muted">{t('history.capped')}</p>
              ) : null}
            </div>
          </SettingsSection>
        </div>
      )}

      <Dialog
        open={previewing}
        title={t('preview.title')}
        onClose={() => setPreviewing(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setPreviewing(false)}>
              {t('preview.cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {t('preview.confirm')}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">{t('preview.body')}</p>
        <ul className="flex flex-col gap-2 text-sm">
          {changes.map((change) => (
            <li key={change.code}>
              <span className="font-medium">{t(`code.${change.code}`)}</span>
              {': '}
              {shown(change.before)} {t('preview.to')} {shown(change.value)}
            </li>
          ))}
        </ul>
      </Dialog>
    </SettingsPage>
  );
}
