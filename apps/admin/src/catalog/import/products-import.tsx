'use client';

import {
  BackLink,
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  FileButton,
  Icon,
  SkeletonRows,
  flashToast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../../api/client.ts';
import { numberFormat } from '../../shared/intl.ts';
import {
  ErrorTable,
  FailureTable,
  FileRow,
  ImportFooter,
  ImportSection,
  ImportSteps,
  ImportTiles,
  LINK_CLASS,
  Meter,
  PreviewTable,
  ProblemBanner,
  StartAsChoice,
} from './import-parts.tsx';
import {
  IMPORT_BASE,
  LIST_PATH,
  PAUSE_PERMISSION,
  canImport,
  isActive,
  stepOf,
  uploadProblemOf,
  type ImportTemplate,
  type ImportView,
  type StartAs,
  type UploadProblem,
} from './import-types.ts';

const POLL_MS = 2500;
const FALLBACK_MAX_BYTES = 10 * 1024 * 1024;

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

/**
 * The Import products page (catalog design 14a; Figma "Import"): Upload file, Check file and
 * Import. The server keeps the state: reloading the page, or opening it from the notice, returns to
 * the step the admin's import is at. A check saves nothing; the confirm starts a background job that
 * runs as the admin and keeps running when the page is left.
 */
export function ProductsImport({
  permissionKeys,
  csrfToken,
  openImportId,
}: {
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
  /** An import named in the address (the notice opens it): shown even when it is finished. */
  readonly openImportId: string | null;
}) {
  const t = useTranslations('catalog.import');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [template, setTemplate] = useState<ImportTemplate | null>(null);
  const [startAs, setStartAs] = useState<StartAs>('inactive');
  const [skip, setSkip] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const cancelled = useRef(false);
  const canPause = permissionKeys.includes(PAUSE_PERMISSION);
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const maxBytes = template?.limits.fileBytes ?? FALLBACK_MAX_BYTES;

  // Without the right to pause, Active is the only start: Inactive is the pause.
  useEffect(() => {
    if (!canPause) setStartAs('active');
  }, [canPause]);

  const load = useCallback(async () => {
    const [current, tpl] = await Promise.all([
      openImportId === null
        ? callApi<{ import: ImportView | null }>('GET', `${IMPORT_BASE}/current`)
        : callApi<ImportView>('GET', `${IMPORT_BASE}/${openImportId}`),
      callApi<ImportTemplate>('GET', `${IMPORT_BASE}/template`),
    ]);
    if (tpl.ok) setTemplate(tpl.body);
    if (!current.ok) {
      setPhase(
        current.failure.status === 404 ? { kind: 'upload', problem: null } : { kind: 'broken' },
      );
      return;
    }
    const view = 'import' in current.body ? current.body.import : current.body;
    // A finished import is shown only when it is asked for; the page otherwise opens clean.
    if (
      view === null ||
      view.state === 'discarded' ||
      (view.state === 'finished' && openImportId === null)
    ) {
      setPhase({ kind: 'upload', problem: null });
      return;
    }
    if (view.startAs !== null) setStartAs(view.startAs);
    setPhase({ kind: 'job', view });
  }, [openImportId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The worker's progress: asked again until the import ends.
  const watched = phase.kind === 'job' && isActive(phase.view.state) ? phase.view.id : null;
  useEffect(() => {
    if (watched === null) return undefined;
    const timer = setInterval(() => {
      void callApi<ImportView>('GET', `${IMPORT_BASE}/${watched}`).then((result) => {
        if (result.ok) setPhase({ kind: 'job', view: result.body });
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [watched]);

  const discard = useCallback(
    async (id: string) => {
      await callApi('POST', `${IMPORT_BASE}/${id}/discard`, {}, csrfToken);
    },
    [csrfToken],
  );

  const upload = useCallback(
    async (file: File) => {
      cancelled.current = false;
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
        { fileName: file.name, data },
        csrfToken,
      );
      if (cancelled.current) {
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
    [csrfToken, discard, maxBytes],
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
    cancelled.current = true;
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

  const start = async (view: ImportView) => {
    setBusy(true);
    setActionFailed(null);
    const result = await callApi<ImportView>(
      'POST',
      `${IMPORT_BASE}/${view.id}/start`,
      { startAs, skipErrors: view.errors > 0 && skip },
      csrfToken,
    );
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setActionFailed(failureKey(result.failure));
      return;
    }
    setPhase({ kind: 'job', view: result.body });
  };

  const resume = async (view: ImportView) => {
    setBusy(true);
    setActionFailed(null);
    const result = await callApi<ImportView>(
      'POST',
      `${IMPORT_BASE}/${view.id}/resume`,
      {},
      csrfToken,
    );
    setBusy(false);
    if (!result.ok) {
      setActionFailed(failureKey(result.failure));
      return;
    }
    setPhase({ kind: 'job', view: result.body });
  };

  const done = (view: ImportView) => {
    flashToast(
      'success',
      t('done-toast', { count: view.added, startAs: view.startAs ?? 'inactive' }),
    );
    goToList();
  };

  const downloadTemplate = () => {
    if (template === null) return;
    const blob = new Blob([template.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = template.filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
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
          <span>{t(`action-error.${actionFailed}`)}</span>
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
                className={`flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center ${
                  dragging ? 'border-accent bg-selected' : 'border-line-control bg-muted'
                }`}
              >
                <Icon name="clipboard" className="size-8 text-fg-muted" />
                <p className="text-sm font-semibold text-fg">{t('upload.drag')}</p>
                <p className="text-sm text-fg-muted">{t('upload.or')}</p>
                <FileButton accept=".csv,text/csv" onFiles={onFiles}>
                  {t('upload.choose')}
                </FileButton>
                <p className="text-xs text-fg-muted">
                  {t('upload.limits', {
                    rows: number(template?.limits.rows ?? 5000),
                    size: Math.round(maxBytes / (1024 * 1024)),
                  })}
                </p>
              </div>
            </ImportSection>
            <ImportSection title={t('template.title')} sub={t('template.sub')}>
              <div>
                <Button variant="secondary" disabled={template === null} onClick={downloadTemplate}>
                  <Icon name="download" className="me-2 size-4" />
                  {t('template.download')}
                </Button>
              </div>
              <dl className="flex flex-col">
                {(template?.columns ?? []).map((column) => (
                  <div
                    key={column.key}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-2"
                  >
                    <dt className="w-32 shrink-0 text-sm font-semibold text-fg">
                      {t(`column.${column.key}`)}
                    </dt>
                    <dd className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                      {column.required ? (
                        <span className="rounded-full bg-neutral-bg px-2.5 py-0.5 text-xs font-medium text-neutral-fg">
                          {t('template.required')}
                        </span>
                      ) : null}
                      <span className="min-w-0 text-xs text-fg-muted sm:ms-auto">
                        {t(`column-help.${column.key}`)}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-fg-muted">{t('template.certification')}</p>
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
                    cancelled.current = true;
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
                  cancelled.current = true;
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
          startAs={startAs}
          skip={skip}
          busy={busy}
          canPause={canPause}
          onStartAs={setStartAs}
          onSkip={setSkip}
          onCancel={() => void cancelCheck()}
          onBack={() => void back()}
          onImport={() => setConfirming(true)}
          onReplace={onFiles}
        />
      ) : null}

      {phase.kind === 'job' && isActive(phase.view.state) ? (
        <>
          <ImportSection title={t('importing.title')}>
            <FileRow
              name={phase.view.fileLabel}
              meta={t('importing.to-add', { count: phase.view.toImport ?? phase.view.ready })}
            />
            <Meter
              label={t('importing.meter')}
              value={percent(
                phase.view.added + phase.view.failed,
                phase.view.toImport ?? phase.view.ready,
              )}
            />
            <p role="status" className="text-sm font-semibold text-fg">
              {t('importing.progress', {
                done: number(phase.view.added + phase.view.failed),
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
        <Finished
          view={phase.view}
          busy={busy}
          canResume={phase.view.canResume}
          onResume={() => void resume(phase.view)}
          onAnother={() => {
            setActionFailed(null);
            setPhase({ kind: 'upload', problem: null });
          }}
          onDone={() => done(phase.view)}
        />
      ) : null}

      {phase.kind === 'job' && phase.view.state === 'checked' ? (
        <Dialog
          open={confirming}
          title={t('confirm.title', { count: number(phase.view.ready) })}
          onClose={() => (busy ? undefined : setConfirming(false))}
          actions={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                {t('cancel')}
              </Button>
              <Button loading={busy} onClick={() => void start(phase.view)}>
                {t('confirm.action')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg-secondary">
            {t('confirm.body', {
              startAs,
              skipped: phase.view.errors > 0 && skip ? phase.view.errors : 0,
            })}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function percent(done: number, total: number): number {
  return total <= 0 ? 0 : Math.round((done / total) * 100);
}

function failureKey(failure: ApiFailure): string {
  switch (failure.code) {
    case 'import.pause-not-allowed':
    case 'import.errors-not-skipped':
    case 'import.already-running':
    case 'import.not-confirmable':
    case 'import.not-resumable':
    case 'import.not-found':
    case 'request.throttled':
    case 'access.denied':
      return failure.code.replace('.', '-');
    default:
      return 'unavailable';
  }
}

function problemValues(
  problem: UploadProblem,
  t: ReturnType<typeof useTranslations>,
): Record<string, string | number> {
  const values: Record<string, string | number> = { ...problem.values };
  if (typeof values.column === 'string' && t.has(`column.${values.column}`)) {
    values.column = t(`column.${values.column}`);
  }
  return values;
}

function CheckResult({
  view,
  startAs,
  skip,
  busy,
  canPause,
  onStartAs,
  onSkip,
  onCancel,
  onBack,
  onImport,
  onReplace,
}: {
  readonly view: ImportView;
  readonly startAs: StartAs;
  readonly skip: boolean;
  readonly busy: boolean;
  readonly canPause: boolean;
  readonly onStartAs: (next: StartAs) => void;
  readonly onSkip: (next: boolean) => void;
  readonly onCancel: () => void;
  readonly onBack: () => void;
  readonly onImport: () => void;
  readonly onReplace: (files: FileList | null) => void;
}) {
  const t = useTranslations('catalog.import');
  const locale = useLocale();
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const clean = view.errors === 0;
  const reportHref = `/api/${IMPORT_BASE}/${view.id}/report?kind=errors`;
  const checked = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(view.checkedAt),
  );
  const ignored = view.ignoredColumns;
  return (
    <>
      <FileRow
        name={view.fileLabel}
        meta={t('result.checked-at', { time: checked, rows: number(view.rows) })}
        action={
          <FileButton accept=".csv,text/csv" onFiles={onReplace} disabled={busy}>
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
        <Banner tone="success" title={t('result.all-ready', { count: number(view.rows) })}>
          <p>{t('result.all-ready-body')}</p>
        </Banner>
      ) : (
        <Banner tone="attention" title={t('result.has-errors', { count: view.errors })}>
          <p>{t('result.has-errors-body')}</p>
        </Banner>
      )}
      {ignored.length === 0 ? null : (
        <Banner tone="info" title={t('result.ignored-title')}>
          <p>
            {t('result.ignored-body', {
              columns: ignored.map((column) => column.header).join(', '),
              certification: ignored.some((column) => column.certification) ? 'yes' : 'no',
            })}
          </p>
        </Banner>
      )}
      {clean ? (
        <PreviewTable rows={view.preview} total={view.rows} />
      ) : (
        <ErrorTable lines={view.errorLines} total={view.errors} reportHref={reportHref} />
      )}
      <ImportSection title={t('settings.title')}>
        <StartAsChoice
          value={startAs}
          onChange={onStartAs}
          disabled={busy}
          inactiveAllowed={canPause}
        />
        {clean ? null : (
          <CheckboxRow
            label={t('settings.skip', { count: view.errors })}
            help={t('settings.skip-help')}
            checked={skip}
            disabled={busy}
            onChange={(event) => onSkip(event.target.checked)}
          />
        )}
      </ImportSection>
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
              {t('result.import', { count: number(view.ready) })}
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
  canResume,
  onResume,
  onAnother,
  onDone,
}: {
  readonly view: ImportView;
  readonly busy: boolean;
  readonly canResume: boolean;
  readonly onResume: () => void;
  readonly onAnother: () => void;
  readonly onDone: () => void;
}) {
  const t = useTranslations('catalog.import');
  const locale = useLocale();
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const stopped = view.state === 'stopped';
  const toImport = view.toImport ?? view.ready;
  const notImported = Math.max(0, toImport - view.added);
  const skippedAtCheck = Math.max(0, view.rows - toImport);
  const reportHref = `/api/${IMPORT_BASE}/${view.id}/report?kind=full`;
  return (
    <>
      {stopped ? (
        <Banner tone="critical" title={t('finished.stopped-title', { count: view.added })}>
          <p>
            {t('finished.stopped-body', {
              added: number(view.added),
              remaining: number(notImported),
              reason:
                view.stopReason !== null && t.has(`stop.${view.stopReason}`)
                  ? view.stopReason
                  : 'unexpected',
            })}
          </p>
        </Banner>
      ) : (
        <Banner
          tone={view.failed > 0 ? 'attention' : 'success'}
          title={t('finished.title', { count: view.added })}
        >
          <p>{t('finished.body', { startAs: view.startAs ?? 'inactive' })}</p>
        </Banner>
      )}
      <ImportTiles
        tiles={[
          { label: t('finished.added'), value: number(view.added), tone: 'success' },
          {
            label: t('finished.skipped'),
            value: number(skippedAtCheck),
            note: t('finished.skipped-note'),
          },
          {
            label: t('finished.not-imported'),
            value: number(notImported),
            ...(notImported > 0
              ? { tone: 'critical' as const, note: t('finished.not-imported-note') }
              : {}),
          },
          {
            label: t('finished.time'),
            value: view.durationSeconds === null ? '–' : durationText(view.durationSeconds, t),
          },
        ]}
      />
      {view.failureLines.length > 0 ? <FailureTable lines={view.failureLines} /> : null}
      <ImportFooter
        start={
          <a className={LINK_CLASS} href={reportHref} download>
            <Icon name="download" className="size-4" />
            {t('finished.report')}
          </a>
        }
        end={
          <>
            <a className={LINK_CLASS} href={LIST_PATH}>
              <Icon name="link" className="size-4" />
              {t('finished.view')}
            </a>
            {stopped && canResume ? (
              <Button loading={busy} onClick={onResume}>
                {t('finished.retry')}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onAnother}>
              {t('finished.another')}
            </Button>
            <Button variant={stopped && canResume ? 'secondary' : 'primary'} onClick={onDone}>
              {t('finished.done')}
            </Button>
          </>
        }
      />
    </>
  );
}
