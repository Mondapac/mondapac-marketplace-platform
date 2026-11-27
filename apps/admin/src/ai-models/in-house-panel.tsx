'use client';

import {
  Badge,
  Banner,
  Button,
  Dialog,
  LoadError,
  Select,
  SettingsSection,
  SettingsSkeleton,
  TextAreaField,
  TextField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { gatewayProblemOf } from '../ai-gateway/errors.ts';
import { find, historyOf, type GatewaySetting, type HistoryEntry } from '../ai-gateway/types.ts';
import { formatInstant } from '../shared/format.ts';
import { REVIEW_NOTE_MAX, isNoteFailure, useSentForReview } from '../shared/review-note.tsx';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import {
  ERRORS_CODE,
  GUARD_CODE,
  IN_HOUSE_CODES,
  IN_HOUSE_PATH,
  ROLLOUT_MAX,
  SAMPLE_CODE,
  SAMPLE_MAX,
  SAMPLE_MIN,
  SHADOW_MAX,
  STAGES,
  inHouseAnswerOf,
  isStage,
  modelCode,
  percentOfPermille,
  permilleOfPercent,
  rolloutCode,
  shadowCode,
  stageCode,
  valueOf,
  wholeWithin,
  type InHouseAnswer,
  type Stage,
} from './in-house-types.ts';
import { MODELS_HISTORY_PATH, MODELS_REVERT_PATH, TASKS, type Task } from './types.ts';

interface TaskDraft {
  readonly stage: Stage;
  readonly model: string;
  readonly shadow: string;
  readonly rollout: string;
}

interface Draft {
  readonly tasks: Readonly<Record<Task, TaskDraft>>;
  /** As typed, in percent with at most one decimal. */
  readonly errors: string;
  readonly guard: string;
  readonly sample: string;
}

const savedDraft = (rows: readonly GatewaySetting[]): Draft => ({
  tasks: Object.fromEntries(
    TASKS.map((task) => {
      const stage = valueOf(rows, stageCode(task));
      return [
        task,
        {
          stage: isStage(stage) ? stage : 'off',
          model: valueOf(rows, modelCode(task)),
          shadow: valueOf(rows, shadowCode(task)),
          rollout: valueOf(rows, rolloutCode(task)),
        },
      ];
    }),
  ) as Record<Task, TaskDraft>,
  errors: percentOfPermille(valueOf(rows, ERRORS_CODE)),
  guard: percentOfPermille(valueOf(rows, GUARD_CODE)),
  sample: valueOf(rows, SAMPLE_CODE),
});

interface Change {
  readonly code: string;
  readonly value: string;
  readonly before: string;
}

type FieldErrors = Readonly<Partial<Record<string, string>>>;

/**
 * What differs between the saved page and the draft, as the API takes it, and the fields typed
 * outside the server's bounds (by code). Nothing is sent while a field is invalid.
 */
function changesOf(
  rows: readonly GatewaySetting[],
  draft: Draft,
): { readonly changes: readonly Change[]; readonly invalid: FieldErrors } {
  const changes: Change[] = [];
  const invalid: Record<string, string> = {};
  const push = (code: string, value: string | null, error: string) => {
    if (value === null) {
      invalid[code] = error;
      return;
    }
    const before = valueOf(rows, code);
    if (before !== value) changes.push({ code, value, before });
  };
  for (const task of TASKS) {
    const item = draft.tasks[task];
    push(stageCode(task), item.stage, '');
    push(modelCode(task), item.model === '' ? 'none' : item.model, '');
    push(shadowCode(task), wholeWithin(item.shadow, 0, SHADOW_MAX), 'shadow');
    push(rolloutCode(task), wholeWithin(item.rollout, 0, ROLLOUT_MAX), 'rollout');
  }
  push(ERRORS_CODE, permilleOfPercent(draft.errors), 'limit');
  push(GUARD_CODE, permilleOfPercent(draft.guard), 'limit');
  push(SAMPLE_CODE, wholeWithin(draft.sample, SAMPLE_MIN, SAMPLE_MAX), 'sample');
  return { changes, invalid };
}

/**
 * Settings › AI Models › Mondapac Intelligence (AI Gateway G6e; docs/design/domain/platform-ai.md
 * section 8, tab 2): per task type the in-house model's stage (off, shadow, percent, default), its
 * model (only among the in-house families the server lists), the shadow and percent shares, and the
 * Market's auto-rollback limits. A preview lists each change before saving; the server decides
 * which change needs the two-step code (anything that sends more to the in-house model or slows
 * its rollback) and checks every rule again. "Roll back to the previous version" is a restore of
 * the model setting from its history, which passes the same checks.
 */
export function InHousePanel({
  canManage,
  csrfToken,
}: {
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('ai-models.in-house');
  const tm = useTranslations('ai-models');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const sentForReview = useSentForReview();
  const [answer, setAnswer] = useState<InHouseAnswer | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldProblems, setFieldProblems] = useState<readonly string[]>([]);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [historyCode, setHistoryCode] = useState(IN_HOUSE_CODES[0] ?? '');
  const [history, setHistory] = useState<readonly HistoryEntry[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const historyWanted = useRef<string>(IN_HOUSE_CODES[0] ?? '');

  async function read(): Promise<InHouseAnswer | null | 'signed-out'> {
    const result = await callApi<unknown>('GET', IN_HOUSE_PATH);
    if (!result.ok && result.failure.status === 401) {
      window.location.assign('/session-ended');
      return 'signed-out';
    }
    return result.ok ? inHouseAnswerOf(result.body) : null;
  }

  async function load() {
    setLoadFailed(false);
    const next = await read();
    if (next === 'signed-out') return;
    if (next === null) {
      setLoadFailed(true);
      return;
    }
    setAnswer(next);
    setDraft(savedDraft(next.settings));
  }

  useEffect(() => {
    void load();
    // Read once when the tab opens.
  }, []);

  if (loadFailed) {
    return (
      <LoadError
        message={t('load-failed')}
        retryLabel={t('retry')}
        onRetry={() => void load()}
        className="flex flex-col items-start gap-3"
      />
    );
  }
  if (answer === null || draft === null) {
    return (
      <SettingsSkeleton
        label={t('loading')}
        header={false}
        sections={[{ fields: 2 }, { fields: 2 }, { fields: 2 }, { fields: 2 }, { fields: 3 }]}
      />
    );
  }

  const rows = answer.settings;
  const { changes, invalid } = changesOf(rows, draft);
  const reviewed = rows.some((row) => row.review?.reviewed === true);
  const optionsOf = (task: Task) => answer.options[task] ?? [];
  const anyFamily = TASKS.some((task) => optionsOf(task).length > 0);
  const problemOf = (task: Task, family: string): string | null => {
    const option = optionsOf(task).find((item) => item.family === family);
    return option === undefined ? 'unknown-model' : option.problem;
  };
  const taskLabel = (task: Task) => tm(`task.${task}.label`);
  const codeLabel = (code: string): string => {
    const task = TASKS.find((item) =>
      [stageCode(item), modelCode(item), shadowCode(item), rolloutCode(item)].includes(code),
    );
    if (task === undefined) return t(`code.${code}`);
    const field =
      code === stageCode(task)
        ? 'stage'
        : code === modelCode(task)
          ? 'model'
          : code === shadowCode(task)
            ? 'shadow'
            : 'rollout';
    return t(`code.${field}`, { task: taskLabel(task) });
  };
  const shown = (code: string, value: string | null): string => {
    if (value === null) return tm('history.default');
    if (code.startsWith('ai-in-house-stage-')) return isStage(value) ? t(`stage.${value}`) : value;
    if (code.startsWith('ai-in-house-model-')) return value === 'none' ? tm('none') : value;
    if (code === ERRORS_CODE || code === GUARD_CODE) {
      return t('percent-value', { value: percentOfPermille(value) });
    }
    if (code === SAMPLE_CODE) return t('calls-value', { value: Number(value) });
    return t('percent-value', { value });
  };

  // A live or shadow stage whose saved model can no longer be used: the gateway serves it as off.
  const alerts = TASKS.flatMap((task) => {
    const stage = valueOf(rows, stageCode(task));
    const family = valueOf(rows, modelCode(task));
    if (stage === 'off' || family === 'none') return [];
    const why = problemOf(task, family);
    return why === null ? [] : [{ task, family, why }];
  });

  async function reload(): Promise<boolean> {
    const next = await read();
    if (next === 'signed-out' || next === null) return false;
    setAnswer(next);
    setDraft(savedDraft(next.settings));
    return true;
  }

  /** "Chat, stage: Shadow isn't approved" lines for the fields of a refused save. */
  const fieldProblemsOf = (
    fields: readonly { readonly path: string; readonly code: string }[],
  ): readonly string[] =>
    fields
      .filter((field) => IN_HOUSE_CODES.includes(field.path))
      .map(
        (field) =>
          `${codeLabel(field.path)}: ${t.has(`problem.${field.code}`) ? t(`problem.${field.code}`) : tm('error.invalid')}`,
      );

  async function write(method: 'PUT' | 'POST', path: string, body: unknown): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setProblem(null);
    setFieldProblems([]);
    setNoteError(null);
    const result = await guarded<unknown>(method, path, body, csrfToken);
    if (result.ok) {
      if (!(await reload())) {
        setProblem('refresh');
        setStale(true);
      }
      setNote('');
      setShowErrors(false);
      toast.success(tm('saved'));
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
        setFieldProblems(fieldProblemsOf(result.failure.details?.fields ?? []));
      }
    }
    setBusy(false);
    return false;
  }

  function openPreview() {
    if (Object.keys(invalid).length > 0) {
      setShowErrors(true);
      return;
    }
    if (reviewed && note.trim() === '') {
      setNoteError('required');
      return;
    }
    setPreviewing(true);
  }

  async function save() {
    await write('PUT', IN_HOUSE_PATH, {
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

  const setTask = (task: Task, patch: Partial<TaskDraft>) =>
    setDraft((current) =>
      current === null
        ? current
        : { ...current, tasks: { ...current.tasks, [task]: { ...current.tasks[task], ...patch } } },
    );
  const disabled = !canManage || busy || stale;
  const dirty = changes.length > 0;
  const errorOf = (code: string, message: string) =>
    showErrors && invalid[code] !== undefined ? message : undefined;

  return (
    <div
      id="ai-models-panel"
      role="tabpanel"
      aria-labelledby="ai-models-panel-tab-own"
      className="flex flex-col gap-6"
    >
      {anyFamily ? null : (
        <Banner tone="info" title={t('no-model.title')}>
          {t('no-model.body')}
        </Banner>
      )}
      {alerts.length === 0 ? null : (
        <Banner tone="attention" title={t('alerts.title')}>
          <ul className="list-disc ps-5">
            {alerts.map((item) => (
              <li key={item.task}>
                {t('alerts.item', {
                  family: item.family,
                  task: taskLabel(item.task),
                  why: t.has(`problem.${item.why}`)
                    ? t(`problem.${item.why}`)
                    : t('problem.unknown-model'),
                })}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {canManage ? null : <Banner tone="info">{tm('read-only')}</Banner>}
      {problem === null ? null : (
        <Banner tone={problem === 'conflict' ? 'attention' : 'critical'}>
          <p>{problem === 'invalid' ? t('invalid') : tm(`error.${problem}`)}</p>
          {fieldProblems.length === 0 ? null : (
            <ul className="list-disc ps-5">
              {fieldProblems.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      {TASKS.map((task) => {
        const item = draft.tasks[task];
        const usable = optionsOf(task).filter((option) => option.problem === null);
        // A chosen model the server no longer lists as usable stays visible, with its problem.
        const modelOptions = [
          ...usable.map((option) => ({ value: option.family, label: option.family })),
          ...(item.model === 'none' || usable.some((option) => option.family === item.model)
            ? []
            : [
                {
                  value: item.model,
                  label: `${item.model} (${t(`problem.${problemOf(task, item.model) ?? 'unknown-model'}`)})`,
                },
              ]),
        ];
        const savedStage = valueOf(rows, stageCode(task));
        const rollback = answer.rollbacks.find((row) => row.task === task);
        // A rollback holds the live stage off until an admin changes the task type's settings.
        const heldOff = rollback?.heldOff === true && savedStage !== 'off';
        return (
          <SettingsSection
            key={task}
            title={taskLabel(task)}
            description={tm(`task.${task}.about`)}
          >
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
              {rollback === undefined ? null : (
                <div className="sm:col-span-2">
                  <Banner
                    tone={rollback.heldOff ? 'critical' : 'info'}
                    title={t(
                      rollback.heldOff ? 'rolled-back.title-held' : 'rolled-back.title-past',
                    )}
                  >
                    <div className="flex flex-col gap-1.5">
                      <p>
                        {t('rolled-back.what', {
                          family: rollback.family,
                          stage: isStage(rollback.stage)
                            ? t(`stage.${rollback.stage}`)
                            : rollback.stage,
                          when: formatInstant(rollback.rolledBackAt, locale),
                        })}
                      </p>
                      <p>
                        {t(`rolled-back.reason.${rollback.reason}`, {
                          count:
                            rollback.reason === 'errors'
                              ? rollback.failures
                              : rollback.guardRejected,
                          calls: rollback.calls,
                          limit: percentOfPermille(
                            String(
                              rollback.reason === 'errors'
                                ? rollback.errorsLimitPermille
                                : rollback.guardLimitPermille,
                            ),
                          ),
                          sample: rollback.minSample,
                        })}
                      </p>
                      <p>{t(rollback.heldOff ? 'rolled-back.held' : 'rolled-back.past')}</p>
                    </div>
                  </Banner>
                </div>
              )}
              <p className="flex flex-wrap items-center gap-2 text-sm sm:col-span-2">
                {t('in-force')}
                <Badge tone={heldOff ? 'critical' : savedStage === 'off' ? 'neutral' : 'info'}>
                  {heldOff
                    ? t('rolled-back.badge', {
                        stage: isStage(savedStage) ? t(`stage.${savedStage}`) : savedStage,
                      })
                    : isStage(savedStage)
                      ? t(`stage.${savedStage}`)
                      : savedStage}
                </Badge>
              </p>
              <Select
                label={t('stage.label', { task: taskLabel(task) })}
                help={t(`stage.help.${item.stage}`)}
                options={STAGES.map((stage) => ({ value: stage, label: t(`stage.${stage}`) }))}
                value={item.stage}
                disabled={disabled}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isStage(next)) setTask(task, { stage: next });
                }}
              />
              <Select
                label={t('model.label', { task: taskLabel(task) })}
                placeholder={t('model.none')}
                help={usable.length === 0 ? t('model.none-usable') : t('model.help')}
                options={modelOptions}
                value={item.model === 'none' ? '' : item.model}
                disabled={disabled}
                onChange={(event) =>
                  setTask(task, { model: event.target.value === '' ? 'none' : event.target.value })
                }
              />
              {item.stage === 'shadow' ? (
                <TextField
                  label={t('shadow.label', { task: taskLabel(task) })}
                  help={t('shadow.help', { max: SHADOW_MAX })}
                  inputMode="numeric"
                  value={item.shadow}
                  disabled={disabled}
                  error={errorOf(shadowCode(task), t('shadow.invalid', { max: SHADOW_MAX }))}
                  onChange={(event) => setTask(task, { shadow: event.target.value })}
                />
              ) : null}
              {item.stage === 'percent' ? (
                <TextField
                  label={t('rollout.label', { task: taskLabel(task) })}
                  help={t('rollout.help', { max: ROLLOUT_MAX })}
                  inputMode="numeric"
                  value={item.rollout}
                  disabled={disabled}
                  error={errorOf(rolloutCode(task), t('rollout.invalid', { max: ROLLOUT_MAX }))}
                  onChange={(event) => setTask(task, { rollout: event.target.value })}
                />
              ) : null}
            </div>
          </SettingsSection>
        );
      })}

      <SettingsSection title={t('rollback.section')} description={t('rollback.intro')}>
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
          <TextField
            label={t('rollback.errors')}
            help={t('rollback.limit-help')}
            inputMode="decimal"
            value={draft.errors}
            disabled={disabled}
            error={errorOf(ERRORS_CODE, t('rollback.limit-invalid'))}
            onChange={(event) =>
              setDraft((current) =>
                current === null ? current : { ...current, errors: event.target.value },
              )
            }
          />
          <TextField
            label={t('rollback.guard')}
            help={t('rollback.limit-help')}
            inputMode="decimal"
            value={draft.guard}
            disabled={disabled}
            error={errorOf(GUARD_CODE, t('rollback.limit-invalid'))}
            onChange={(event) =>
              setDraft((current) =>
                current === null ? current : { ...current, guard: event.target.value },
              )
            }
          />
          <TextField
            label={t('rollback.sample')}
            help={t('rollback.sample-help', { min: SAMPLE_MIN, max: SAMPLE_MAX })}
            inputMode="numeric"
            value={draft.sample}
            disabled={disabled}
            error={errorOf(
              SAMPLE_CODE,
              t('rollback.sample-invalid', { min: SAMPLE_MIN, max: SAMPLE_MAX }),
            )}
            onChange={(event) =>
              setDraft((current) =>
                current === null ? current : { ...current, sample: event.target.value },
              )
            }
          />
        </div>
      </SettingsSection>

      {canManage ? (
        <SettingsSection title={tm('save.section')} description={t('save-intro')}>
          <div className="flex flex-col gap-4 px-5 py-4">
            <TextAreaField
              label={tm('note.label')}
              help={tm('note.help', { max: REVIEW_NOTE_MAX })}
              error={noteError === null ? undefined : tm(`note.error.${noteError}`)}
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
              <Button
                disabled={disabled || (changes.length === 0 && Object.keys(invalid).length === 0)}
                onClick={openPreview}
              >
                {tm('save.review')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy || (changes.length === 0 && Object.keys(invalid).length === 0)}
                onClick={() => {
                  setShowErrors(false);
                  setDraft(savedDraft(rows));
                }}
              >
                {tm('save.discard')}
              </Button>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection title={tm('history.section')} description={t('history-intro')}>
        <div className="flex flex-col gap-4 px-5 py-4">
          <Select
            label={tm('history.setting')}
            options={IN_HOUSE_CODES.map((code) => ({ value: code, label: codeLabel(code) }))}
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
              {tm('history.show')}
            </Button>
          </div>
          {historyFailed ? <Banner tone="critical">{tm('history.failed')}</Banner> : null}
          {history !== null && history.length === 0 ? (
            <p className="text-sm">{tm('history.empty')}</p>
          ) : null}
          {history !== null && history.length > 0 ? (
            <ul className="flex flex-col divide-y divide-line" aria-label={tm('history.list')}>
              {history.map((entry) => (
                <li
                  key={entry.version}
                  className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center"
                >
                  <div className="flex-1 text-sm">
                    <p>
                      {tm('history.change', {
                        version: entry.version,
                        before: shown(entry.code, entry.previousValue),
                        after: shown(entry.code, entry.value),
                      })}
                      {entry.current ? <Badge tone="info">{tm('history.current')}</Badge> : null}
                    </p>
                    <p className="break-words text-fg-muted">
                      {tm('history.by-at', {
                        name: entry.changedBy ?? tm('history.unknown'),
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
                        aria-label={tm('history.restore-value', {
                          version: entry.version,
                          value: shown(entry.code, entry.value),
                        })}
                        onClick={() => void restore(entry.code, entry.version)}
                      >
                        {tm('history.restore', { version: entry.version })}
                      </Button>
                      {entry.previousValue === null ? (
                        <Button
                          variant="secondary"
                          disabled={disabled || dirty}
                          onClick={() => void restore(entry.code, 0)}
                        >
                          {tm('history.restore-default')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {history !== null && history.length >= 50 ? (
            <p className="text-sm text-fg-muted">{tm('history.capped')}</p>
          ) : null}
        </div>
      </SettingsSection>

      <Dialog
        open={previewing}
        title={tm('preview.title')}
        onClose={() => setPreviewing(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setPreviewing(false)}>
              {tm('preview.cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {tm('preview.confirm')}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">{t('preview-body')}</p>
        <ul className="flex flex-col gap-2 text-sm">
          {changes.map((change) => (
            <li key={change.code}>
              <span className="font-medium">{codeLabel(change.code)}</span>
              {': '}
              {shown(change.code, change.before)} {tm('preview.to')}{' '}
              {shown(change.code, change.value)}
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
