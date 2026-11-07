'use client';

import {
  BackLink,
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  FileButton,
  Icon,
  RadioGroup,
  SkeletonRows,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../../api/client.ts';
import { numberFormat } from '../../shared/intl.ts';
import {
  ErrorTable,
  FailureTable,
  FileRow,
  IgnoredColumns,
  ImportFooter,
  LINK_CLASS,
  ImportSection,
  ImportSteps,
  ImportTiles,
  Meter,
  PreviewTable,
  ProblemBanner,
} from './import-parts.tsx';
import {
  IMPORT_BASE,
  IMPORT_MODES,
  LIST_PATH,
  actionErrorKey,
  canImport,
  canOfferResume,
  isActive,
  stepOf,
  uploadProblemOf,
  type ImportMode,
  type ImportTemplate,
  type ImportView,
  type UploadProblem,
} from './import-types.ts';
import { PhotoStep } from './photo-step.tsx';
import { downloadReport, type ReportKind } from './report-download.ts';

const POLL_MS = 3000;
const FALLBACK_MAX_BYTES = 10 * 1024 * 1024;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** What the file picker offers: CSV and XLSX. The API reads the type from the content, not the name. */
const IMPORT_ACCEPT = `.csv,.xlsx,text/csv,${XLSX_TYPE}`;

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'upload'; readonly problem: UploadProblem | null }
  | { readonly kind: 'checking'; readonly name: string; readonly bytes: number }
  | { readonly kind: 'job'; readonly view: ImportView }
  | { readonly kind: 'broken' };

/** The file as base64 text, read in the browser; null when it cannot be read. */
function readAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const comma = text.indexOf(',');
      resolve(comma < 0 ? null : text.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function sizeText(bytes: number, locale: string): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${numberFormat(locale, { maximumFractionDigits: 1 }).format(mb)} MB`;
  return `${numberFormat(locale, { maximumFractionDigits: 0 }).format(Math.max(1, bytes / 1024))} KB`;
}

/** The word the messages select on: select keys can't hold a hyphen. */
function kindOf(mode: ImportMode): 'catalogue' | 'mine' {
  return mode === 'sell-from-catalogue' ? 'catalogue' : 'mine';
}

/** The values of an upload problem; column keys read as the template's column names. */
function problemValues(
  problem: UploadProblem,
  t: ReturnType<typeof useTranslations>,
): Record<string, string | number> {
  if (problem.columns === undefined) return { ...problem.values };
  const names = problem.columns.map((key) => (t.has(`column.${key}`) ? t(`column.${key}`) : key));
  return { ...problem.values, count: names.length, columns: names.join(', ') };
}

function percent(done: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
}

/** The rows the run has dealt with so far, whatever came of them. */
function rowsDone(view: ImportView): number {
  return view.created + view.updated + view.unchanged + view.failed;
}

/**
 * The seller Import page (catalog design 14c; the seller counterpart of the admin's): Upload file,
 * Check file, Import, then the photo step. The server keeps the state: reloading the page returns to
 * the step the seller's import is at. A check saves nothing; the confirm starts a background job
 * that runs as the seller's account and keeps running when the page is left.
 */
export function SellerImport({
  csrfToken,
  now,
  minPhotoIntervalMs,
}: {
  readonly csrfToken: string;
  /** The clock for the photo step's wait; tests pass their own. */
  readonly now?: () => number;
  readonly minPhotoIntervalMs?: number;
}) {
  const t = useTranslations('catalog.import');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [template, setTemplate] = useState<ImportTemplate | null>(null);
  const [mode, setMode] = useState<ImportMode>('my-products');
  const [skip, setSkip] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Each upload takes a number; an answer is used only while its number is the latest, so a late
  // answer of a cancelled or replaced upload is ignored.
  const uploadToken = useRef(0);
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const maxBytes = template?.limits.fileBytes ?? FALLBACK_MAX_BYTES;
  const templateOfMode = template?.modes.find((entry) => entry.mode === mode) ?? null;

  const load = useCallback(async () => {
    const [current, tpl] = await Promise.all([
      callApi<{ import: ImportView | null }>('GET', `${IMPORT_BASE}/current`),
      callApi<ImportTemplate>('GET', `${IMPORT_BASE}/template`),
    ]);
    if (tpl.ok) setTemplate(tpl.body);
    if (!current.ok) {
      setPhase({ kind: 'broken' });
      return;
    }
    const view = current.body.import;
    // A finished import stays on the page while its photo step is open; otherwise the page opens clean.
    if (
      view === null ||
      view.state === 'discarded' ||
      (view.state === 'finished' && !view.photoStepOpen)
    ) {
      setPhase({ kind: 'upload', problem: null });
      return;
    }
    setMode(view.mode);
    setPhase({ kind: 'job', view });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The worker's progress: asked again until the import ends.
  const watched = phase.kind === 'job' && isActive(phase.view.state) ? phase.view.id : null;
  useEffect(() => {
    if (watched === null) return undefined;
    const timer = setInterval(() => {
      void callApi<ImportView>('GET', `${IMPORT_BASE}/${watched}`).then((result) => {
        if (result.ok) {
          setPhase({ kind: 'job', view: result.body });
          return;
        }
        // A session that ended or an import that is gone will not come back by asking again.
        if (['session.invalid', 'request.csrf', 'import.not-found'].includes(result.failure.code)) {
          clearInterval(timer);
          setActionFailed(actionErrorKey(result.failure));
          if (result.failure.code === 'import.not-found') void load();
        }
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [watched, load]);

  const discard = useCallback(
    async (id: string) => {
      await callApi('POST', `${IMPORT_BASE}/${id}/discard`, {}, csrfToken);
    },
    [csrfToken],
  );

  const upload = useCallback(
    async (file: File) => {
      const token = ++uploadToken.current;
      setActionFailed(null);
      if (file.size > maxBytes) {
        setPhase({
          kind: 'upload',
          problem: uploadProblemOf({ status: 413, code: 'file.too-large', details: { maxBytes } }),
        });
        return;
      }
      setPhase({ kind: 'checking', name: file.name, bytes: file.size });
      const data = await readAsBase64(file);
      if (token !== uploadToken.current) return;
      if (data === null) {
        setPhase({
          kind: 'upload',
          problem: uploadProblemOf({ status: 0, code: 'file.unreadable' }),
        });
        return;
      }
      const result = await callApi<ImportView>(
        'POST',
        IMPORT_BASE,
        { mode, fileName: file.name, data },
        csrfToken,
      );
      if (token !== uploadToken.current) {
        if (result.ok) await discard(result.body.id);
        return;
      }
      if (!result.ok) {
        setPhase({ kind: 'upload', problem: uploadProblemOf(result.failure) });
        return;
      }
      setSkip(false);
      setPhase({ kind: 'job', view: result.body });
    },
    [csrfToken, discard, maxBytes, mode],
  );

  const onFiles = (files: FileList | null) => {
    const file = files?.item(0);
    if (file !== null && file !== undefined) void upload(file);
  };

  const goToList = () => {
    window.location.assign(LIST_PATH);
  };

  const cancelCheck = async () => {
    if (phase.kind === 'job' && phase.view.state === 'checked') await discard(phase.view.id);
    uploadToken.current += 1;
    goToList();
  };

  const back = async () => {
    if (phase.kind === 'job' && phase.view.state === 'checked') {
      setBusy(true);
      await discard(phase.view.id);
      setBusy(false);
    }
    setPhase({ kind: 'upload', problem: null });
  };

  const step = async (view: ImportView, action: 'start' | 'resume') => {
    setBusy(true);
    setActionFailed(null);
    const result = await callApi<ImportView>(
      'POST',
      `${IMPORT_BASE}/${view.id}/${action}`,
      action === 'start' ? { skipErrors: view.errors > 0 && skip } : {},
      csrfToken,
    );
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      failWith(result.failure);
      return;
    }
    setPhase({ kind: 'job', view: result.body });
  };

  const failWith = (failure: ApiFailure) => {
    setActionFailed(actionErrorKey(failure));
    // A lost access or a vanished import cannot be retried: the page reads the server's state again.
    if (failure.code === 'import.access-lost' || failure.code === 'import.not-found') {
      void load();
    }
  };

  const report = async (view: ImportView, kind: ReportKind) => {
    setActionFailed(null);
    const result = await downloadReport(view.id, kind);
    if (!result.ok) failWith(result.failure);
  };

  const downloadTemplate = (format: 'csv' | 'xlsx') => {
    if (templateOfMode === null) return;
    const blob =
      format === 'csv'
        ? new Blob([templateOfMode.csv], { type: 'text/csv;charset=utf-8' })
        : new Blob([Uint8Array.from(atob(templateOfMode.xlsx), (char) => char.charCodeAt(0))], {
            type: XLSX_TYPE,
          });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = format === 'csv' ? templateOfMode.filename : templateOfMode.xlsxFilename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const active =
    phase.kind === 'job'
      ? stepOf(phase.view.state)
      : stepOf(phase.kind === 'checking' ? 'checking' : 'upload');

  return (
    <div className="flex flex-col gap-4">
      <div>
        <BackLink href={LIST_PATH} label={t('back')} />
        <h1 className="text-2xl font-semibold text-fg">{t('title')}</h1>
        <p className="text-sm text-fg-muted">{t('subtitle')}</p>
      </div>
      <ImportSteps active={active} />
      {actionFailed === null ? null : (
        <Banner tone="critical">
          <span role="alert">{t(`action-error.${actionFailed}`)}</span>
        </Banner>
      )}
      {phase.kind === 'loading' ? <SkeletonRows label={t('loading')} rows={4} /> : null}
      {phase.kind === 'broken' ? (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('problem-load')}</span>
            <Button variant="secondary" onClick={() => void load()}>
              {tl('retry')}
            </Button>
          </div>
        </Banner>
      ) : null}

      {phase.kind === 'upload' ? (
        <>
          {phase.problem === null ? null : (
            <ProblemBanner
              tone={phase.problem.tone}
              title={t(
                `upload-problem.${phase.problem.key}.title`,
                problemValues(phase.problem, t),
              )}
              body={t(`upload-problem.${phase.problem.key}.body`, problemValues(phase.problem, t))}
            />
          )}
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
            <ImportSection title={t('upload.title')} sub={t('upload.sub')}>
              <RadioGroup
                legend={t('mode.legend')}
                name="import-mode"
                value={mode}
                onChange={(value) =>
                  setMode(value === 'sell-from-catalogue' ? value : 'my-products')
                }
                options={IMPORT_MODES.map((entry) => ({
                  value: entry,
                  label: t(`mode.${entry}.label`),
                  help: t(`mode.${entry}.help`),
                }))}
              />
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  onFiles(event.dataTransfer.files);
                }}
                className={`flex min-h-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center ${
                  dragging ? 'border-accent bg-selected' : 'border-line-control bg-muted'
                }`}
              >
                <Icon name="clipboard" className="size-8 text-fg-muted" />
                <p className="text-sm font-semibold text-fg">{t('upload.drag')}</p>
                <p className="text-sm text-fg-muted">{t('upload.or')}</p>
                <FileButton accept={IMPORT_ACCEPT} onFiles={onFiles}>
                  {t('upload.choose')}
                </FileButton>
                <p className="text-xs text-fg-muted">
                  {t('upload.limits', {
                    rows: template?.limits.rows ?? 5000,
                    size: Math.round(maxBytes / (1024 * 1024)),
                  })}
                </p>
              </div>
            </ImportSection>
            <ImportSection title={t('template.title')} sub={t(`template.sub-${mode}`)}>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={templateOfMode === null}
                  onClick={() => downloadTemplate('csv')}
                >
                  <Icon name="download" className="me-2 size-4" />
                  {t('template.download-csv')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={templateOfMode === null}
                  onClick={() => downloadTemplate('xlsx')}
                >
                  <Icon name="download" className="me-2 size-4" />
                  {t('template.download-xlsx')}
                </Button>
              </div>
              <dl className="flex flex-col">
                {(templateOfMode?.columns ?? []).map((column) => (
                  <div
                    key={column.key}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-2"
                  >
                    <dt className="w-36 shrink-0 break-words text-sm font-semibold text-fg">
                      {column.header}
                    </dt>
                    <dd className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                      {column.required ? (
                        <span className="rounded-full bg-neutral-bg px-2.5 py-0.5 text-xs font-medium text-neutral-fg">
                          {t('template.required')}
                        </span>
                      ) : null}
                      {t.has(`column-help.${column.key}`) ? (
                        <span className="min-w-0 text-xs text-fg-muted sm:ms-auto">
                          {t(`column-help.${column.key}`)}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-fg-muted">{t('template.not-imported')}</p>
            </ImportSection>
          </div>
          <ImportFooter
            start={
              <Button variant="secondary" onClick={goToList}>
                {t('cancel')}
              </Button>
            }
          />
        </>
      ) : null}

      {phase.kind === 'checking' ? (
        <>
          <ImportSection title={t('checking.title')} sub={t('checking.sub')}>
            <FileRow
              name={phase.name}
              meta={sizeText(phase.bytes, locale)}
              action={
                <Button
                  variant="link"
                  onClick={() => {
                    uploadToken.current += 1;
                    setPhase({ kind: 'upload', problem: null });
                  }}
                >
                  {t('checking.stop')}
                </Button>
              }
            />
            <Meter label={t('checking.meter')} value={null} />
            <p role="status" className="text-sm text-fg-muted">
              {t('checking.status')}
            </p>
          </ImportSection>
          <ImportFooter
            start={
              <Button
                variant="secondary"
                onClick={() => {
                  uploadToken.current += 1;
                  goToList();
                }}
              >
                {t('cancel')}
              </Button>
            }
          />
        </>
      ) : null}

      {phase.kind === 'job' && phase.view.state === 'checked' ? (
        <CheckResult
          view={phase.view}
          skip={skip}
          busy={busy}
          onSkip={setSkip}
          onCancel={() => void cancelCheck()}
          onBack={() => void back()}
          onImport={() => setConfirming(true)}
          onReplace={onFiles}
          onReport={() => void report(phase.view, 'errors')}
        />
      ) : null}

      {phase.kind === 'job' && isActive(phase.view.state) ? (
        <>
          <ImportSection title={t('importing.title')}>
            <FileRow
              name={phase.view.fileLabel}
              meta={t('importing.to-do', { count: phase.view.toImport ?? phase.view.ready })}
            />
            <Meter
              label={t('importing.meter')}
              value={percent(rowsDone(phase.view), phase.view.toImport ?? phase.view.ready)}
            />
            <p role="status" className="text-sm font-semibold text-fg">
              {t('importing.progress', {
                done: number(rowsDone(phase.view)),
                total: number(phase.view.toImport ?? phase.view.ready),
              })}
            </p>
            <Banner tone="info" title={t('importing.leave-title')}>
              <p>{t('importing.leave-body')}</p>
            </Banner>
          </ImportSection>
          <ImportFooter
            end={
              <Button variant="secondary" onClick={goToList}>
                {t('importing.back')}
              </Button>
            }
          />
        </>
      ) : null}

      {phase.kind === 'job' &&
      (phase.view.state === 'finished' || phase.view.state === 'stopped') ? (
        <>
          <Finished
            view={phase.view}
            busy={busy}
            onResume={() => void step(phase.view, 'resume')}
            onAnother={() => {
              setActionFailed(null);
              setPhase({ kind: 'upload', problem: null });
            }}
            onReport={() => void report(phase.view, 'full')}
          />
          {phase.view.photoStepOpen ? (
            <PhotoStep
              importId={phase.view.id}
              csrfToken={csrfToken}
              {...(now === undefined ? {} : { now })}
              {...(minPhotoIntervalMs === undefined ? {} : { minIntervalMs: minPhotoIntervalMs })}
            />
          ) : null}
        </>
      ) : null}

      {phase.kind === 'job' && phase.view.state === 'checked' ? (
        <Dialog
          open={confirming}
          title={t('confirm.title', { count: phase.view.ready })}
          onClose={() => (busy ? undefined : setConfirming(false))}
          actions={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                {t('cancel')}
              </Button>
              <Button loading={busy} onClick={() => void step(phase.view, 'start')}>
                {t('confirm.action')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg-secondary">
            {t('confirm.body', {
              mode: kindOf(phase.view.mode),
              skipped: phase.view.errors > 0 && skip ? phase.view.errors : 0,
            })}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function CheckResult({
  view,
  skip,
  busy,
  onSkip,
  onCancel,
  onBack,
  onImport,
  onReplace,
  onReport,
}: {
  readonly view: ImportView;
  readonly skip: boolean;
  readonly busy: boolean;
  readonly onSkip: (next: boolean) => void;
  readonly onCancel: () => void;
  readonly onBack: () => void;
  readonly onImport: () => void;
  readonly onReplace: (files: FileList | null) => void;
  readonly onReport: () => void;
}) {
  const t = useTranslations('catalog.import');
  const locale = useLocale();
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const clean = view.errors === 0;
  const checked = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(view.checkedAt),
  );
  return (
    <>
      <FileRow
        name={view.fileLabel}
        meta={t('result.checked-at', { time: checked, rows: view.rows })}
        action={
          <FileButton accept={IMPORT_ACCEPT} onFiles={onReplace} disabled={busy}>
            {clean ? t('result.choose-another') : t('result.upload-corrected')}
          </FileButton>
        }
      />
      <ImportTiles
        tiles={[
          { label: t('tiles.rows'), value: number(view.rows) },
          { label: t('tiles.ready'), value: number(view.ready), tone: 'success' },
          {
            label: t('tiles.errors'),
            value: number(view.errors),
            ...(view.errors > 0 ? { tone: 'critical' as const, note: t('tiles.errors-note') } : {}),
          },
          {
            label: t('tiles.warnings'),
            value: number(view.warnings),
            ...(view.warnings > 0
              ? { tone: 'attention' as const, note: t('tiles.warnings-note') }
              : {}),
          },
        ]}
      />
      {clean ? (
        <Banner tone="success" title={t('result.all-ready', { count: view.rows })}>
          <p>{t('result.all-ready-body')}</p>
          {view.warnings > 0 ? <p className="mt-1">{t('result.warnings-clean')}</p> : null}
        </Banner>
      ) : (
        <Banner tone="attention" title={t('result.has-errors', { count: view.errors })}>
          <p>{t('result.has-errors-body')}</p>
        </Banner>
      )}
      <IgnoredColumns columns={view.ignoredColumns} />
      {clean ? (
        <PreviewTable rows={view.preview} total={view.rows} mode={view.mode} />
      ) : (
        <ErrorTable lines={view.errorLines} total={view.errors} onReport={onReport} />
      )}
      {clean ? null : (
        <ImportSection title={t('settings.title')}>
          <CheckboxRow
            label={t('settings.skip', { count: view.errors })}
            help={t('settings.skip-help')}
            checked={skip}
            disabled={busy}
            onChange={(event) => onSkip(event.target.checked)}
          />
        </ImportSection>
      )}
      <ImportFooter
        start={
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
        }
        end={
          <>
            <Button variant="secondary" disabled={busy} onClick={onBack}>
              {t('result.back')}
            </Button>
            <Button disabled={busy || !canImport(view, skip)} onClick={onImport}>
              {t('result.import', { count: number(view.ready), mode: kindOf(view.mode) })}
            </Button>
          </>
        }
      />
    </>
  );
}

function durationText(seconds: number, t: ReturnType<typeof useTranslations>): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0
    ? t('finished.duration-minutes', { minutes, seconds: seconds % 60 })
    : t('finished.duration-seconds', { seconds });
}

function Finished({
  view,
  busy,
  onResume,
  onAnother,
  onReport,
}: {
  readonly view: ImportView;
  readonly busy: boolean;
  readonly onResume: () => void;
  readonly onAnother: () => void;
  readonly onReport: () => void;
}) {
  const t = useTranslations('catalog.import');
  const locale = useLocale();
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const stopped = view.state === 'stopped';
  const toImport = view.toImport ?? view.ready;
  const notImported = Math.max(0, toImport - view.created - view.updated - view.unchanged);
  const offerResume = canOfferResume(view);
  const reason =
    view.stopReason !== null && t.has(`stop.${view.stopReason}.label`)
      ? view.stopReason
      : 'unexpected';
  return (
    <>
      {stopped ? (
        <Banner
          tone="critical"
          title={t('finished.stopped-title', { count: view.created + view.updated })}
        >
          <p>
            {t('finished.stopped-body', {
              remaining: notImported,
              next: offerResume ? 'resume' : 'new',
            })}
          </p>
          <p className="mt-1 font-semibold">{t(`stop.${reason}.label`)}</p>
          <p>{t(`stop.${reason}.help`)}</p>
        </Banner>
      ) : (
        <Banner
          tone="success"
          title={t('finished.title', { count: view.created + view.updated + view.unchanged })}
        >
          <p>{t('finished.body', { mode: kindOf(view.mode) })}</p>
        </Banner>
      )}
      <ImportTiles
        tiles={[
          { label: t('finished.created'), value: number(view.created), tone: 'success' },
          { label: t('finished.updated'), value: number(view.updated) },
          { label: t('finished.unchanged'), value: number(view.unchanged) },
          {
            label: t('finished.not-imported'),
            value: number(Math.max(view.failed, notImported)),
            ...(Math.max(view.failed, notImported) > 0
              ? { tone: 'critical' as const, note: t('finished.not-imported-note') }
              : {}),
          },
        ]}
      />
      {view.durationSeconds === null ? null : (
        <p className="text-sm text-fg-muted">
          {t('finished.time', { time: durationText(view.durationSeconds, t) })}
        </p>
      )}
      {view.failureLines.length > 0 ? <FailureTable lines={view.failureLines} /> : null}
      <ImportFooter
        start={
          <Button variant="link" onClick={onReport}>
            <Icon name="download" className="me-1.5 size-4" />
            {t('finished.report')}
          </Button>
        }
        end={
          <>
            <a className={LINK_CLASS} href={LIST_PATH}>
              <Icon name="link" className="size-4" />
              {t('finished.view')}
            </a>
            {offerResume ? (
              <Button loading={busy} onClick={onResume}>
                {t('finished.retry')}
              </Button>
            ) : null}
            <Button variant={offerResume ? 'secondary' : 'primary'} onClick={onAnother}>
              {t('finished.another')}
            </Button>
          </>
        }
      />
    </>
  );
}
