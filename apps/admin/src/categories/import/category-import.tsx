'use client';

import {
  BackLink,
  Badge,
  Banner,
  Button,
  CARD_TABLE,
  Card,
  Dialog,
  LinkButton,
  FileButton,
  flashToast,
  saveFile,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../../api/client.ts';
import {
  ImportFooter,
  ImportSection,
  ImportTiles,
  FileRow,
} from '../../catalog/import/import-parts.tsx';
import { numberFormat } from '../../shared/intl.ts';
import {
  API_IMPORT,
  canApply,
  errorReportCsv,
  problemOf,
  readAsBase64,
  visibleRows,
  type ApplyBody,
  type DryRunBody,
  type ImportProblem,
  type RowAction,
  type RowFilter,
} from './import-model.ts';
import { exportTree } from './export-tree.ts';

const IMPORT_ACCEPT =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FALLBACK_MAX_MB = 5;

const ACTION_TONE: Record<RowAction, BadgeTone> = {
  create: 'success',
  update: 'info',
  unchanged: 'neutral',
  error: 'critical',
};

/** The words of one problem code of a row; a code the page does not know shows as it is. */
const ROW_CODES = new Set([
  'slug.invalid',
  'slug.duplicate',
  'slug.taken',
  'parent.invalid',
  'parent.not-found',
  'move.not-supported',
  'depth.exceeded',
  'required',
  'sibling-name-taken',
  'show-in-menu.invalid',
  'blocked-term',
  'claim-word',
  'locale-uncheckable',
  'tree.size-exceeded',
  'row.invalid',
]);

interface Checked {
  readonly name: string;
  readonly bytes: number;
  /** The file as base64: the apply sends the same file again. */
  readonly data: string;
  readonly body: DryRunBody;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking'; readonly name: string }
  | { readonly kind: 'checked'; readonly file: Checked }
  | { readonly kind: 'applied'; readonly body: ApplyBody };

/**
 * The Import categories page (categories package C7b): choose a CSV or XLSX file, see per row what
 * it would do (nothing is written), then apply a file with no error. Create and update only: a row
 * that names another parent is an error, and moves keep their dialog on the tree page.
 */
export function CategoryImport({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('categories.import');
  const locale = useLocale();
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  const fail = (failure: ApiFailure): void => {
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(problemOf(failure));
  };

  /** Reads the file once; the check and the apply both send it. */
  async function check(name: string, bytes: number, data: string) {
    setProblem(null);
    setFilter('all');
    setPhase({ kind: 'checking', name });
    const result = await callApi<DryRunBody>('POST', `${API_IMPORT}/dry-run`, { data }, csrfToken);
    if (!result.ok) {
      setPhase({ kind: 'idle' });
      fail(result.failure);
      return;
    }
    setPhase({ kind: 'checked', file: { name, bytes, data, body: result.body } });
  }

  async function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined || file === null || working.current) return;
    working.current = true;
    try {
      const data = await readAsBase64(file);
      if (data === null) {
        setProblem({ kind: 'file', code: 'file.unreadable', maxBytes: null });
        return;
      }
      await check(file.name, file.size, data);
    } finally {
      working.current = false;
    }
  }

  async function apply(file: Checked) {
    setBusy(true);
    const result = await callApi<ApplyBody>(
      'POST',
      `${API_IMPORT}/apply`,
      { data: file.data, fileSha256: file.body.fileSha256, treeVersion: file.body.treeVersion },
      csrfToken,
    );
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      fail(result.failure);
      return;
    }
    setProblem(null);
    setPhase({ kind: 'applied', body: result.body });
    flashToast(
      'success',
      t('applied-toast', {
        created: result.body.counts.create,
        updated: result.body.counts.update,
      }),
    );
  }

  function downloadReport(file: Checked) {
    saveFile(
      new Blob([errorReportCsv(file.body.rows)], { type: 'text/csv;charset=utf-8' }),
      `category-import-errors-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }

  const checked = phase.kind === 'checked' ? phase.file : null;
  const checkingFile = phase.kind === 'checking' || busy;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <BackLink href="/catalog/categories" label={t('back')} />
      <p className="max-w-prose text-fg-muted">{t('intro')}</p>

      {problem === null ? null : (
        <ProblemBanner
          problem={problem}
          onCheckAgain={
            checked === null
              ? undefined
              : () => void check(checked.name, checked.bytes, checked.data)
          }
        />
      )}

      {phase.kind === 'applied' ? (
        <ImportSection title={t('done.title')}>
          <ImportTiles
            tiles={[
              {
                label: t('tiles.create'),
                value: number(phase.body.counts.create),
                tone: 'success',
              },
              { label: t('tiles.update'), value: number(phase.body.counts.update) },
              { label: t('tiles.unchanged'), value: number(phase.body.counts.unchanged) },
            ]}
          />
          <p className="text-sm text-fg-muted">{t('done.hidden-note')}</p>
          <ImportFooter
            end={
              <>
                <FileButton
                  accept={IMPORT_ACCEPT}
                  onFiles={(files) => {
                    setPhase({ kind: 'idle' });
                    void onFiles(files);
                  }}
                >
                  {t('choose-another')}
                </FileButton>
                <LinkButton href="/catalog/categories">{t('done.open-tree')}</LinkButton>
              </>
            }
          />
        </ImportSection>
      ) : null}

      {phase.kind === 'idle' || phase.kind === 'checking' ? (
        <ImportSection title={t('upload.title')} sub={t('upload.sub')}>
          <div className="flex flex-wrap items-center gap-3">
            <FileButton
              accept={IMPORT_ACCEPT}
              onFiles={(files) => void onFiles(files)}
              disabled={checkingFile}
            >
              {t('upload.choose')}
            </FileButton>
            <ExportLinks />
          </div>
          <p className="text-xs text-fg-muted" role="status">
            {phase.kind === 'checking'
              ? t('checking', { name: phase.name })
              : t('upload.limits', { size: FALLBACK_MAX_MB })}
          </p>
        </ImportSection>
      ) : null}

      {checked === null ? null : (
        <>
          <FileRow
            name={checked.name}
            meta={t('file-meta', {
              rows: number(
                checked.body.counts.create +
                  checked.body.counts.update +
                  checked.body.counts.unchanged +
                  checked.body.counts.error,
              ),
              format: checked.body.format.toUpperCase(),
            })}
            action={
              <FileButton
                accept={IMPORT_ACCEPT}
                onFiles={(files) => void onFiles(files)}
                disabled={busy}
              >
                {checked.body.counts.error > 0 ? t('upload-corrected') : t('choose-another')}
              </FileButton>
            }
          />
          <ImportTiles
            tiles={[
              {
                label: t('tiles.create'),
                value: number(checked.body.counts.create),
                tone: 'success',
              },
              { label: t('tiles.update'), value: number(checked.body.counts.update) },
              { label: t('tiles.unchanged'), value: number(checked.body.counts.unchanged) },
              {
                label: t('tiles.errors'),
                value: number(checked.body.counts.error),
                ...(checked.body.counts.error > 0
                  ? { tone: 'critical' as const, note: t('tiles.errors-note') }
                  : {}),
              },
            ]}
          />
          {checked.body.counts.error > 0 ? (
            <Banner tone="critical">
              {t('result.has-errors', { count: checked.body.counts.error })}
            </Banner>
          ) : canApply(checked.body) ? (
            <Banner tone="success">{t('result.ready')}</Banner>
          ) : (
            <Banner tone="info">{t('result.nothing')}</Banner>
          )}
          <ResultTable rows={checked.body} filter={filter} onFilter={setFilter} />
          <ImportFooter
            start={
              checked.body.counts.error > 0 ? (
                <Button variant="secondary" onClick={() => downloadReport(checked)}>
                  {t('download-report')}
                </Button>
              ) : undefined
            }
            end={
              <Button
                disabled={!canApply(checked.body) || busy}
                onClick={() => setConfirming(true)}
              >
                {t('apply')}
              </Button>
            }
          />
          <Dialog
            open={confirming}
            title={t('confirm.title', {
              count: checked.body.counts.create + checked.body.counts.update,
            })}
            onClose={() => (busy ? undefined : setConfirming(false))}
            actions={
              <>
                <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                  {t('cancel')}
                </Button>
                <Button loading={busy} onClick={() => void apply(checked)}>
                  {t('confirm.action')}
                </Button>
              </>
            }
          >
            <p className="text-sm text-fg-secondary">
              {t('confirm.body', {
                created: checked.body.counts.create,
                updated: checked.body.counts.update,
              })}
            </p>
          </Dialog>
        </>
      )}
    </div>
  );
}

/** The export of the tree, as the starting point of a file. */
function ExportLinks() {
  const t = useTranslations('categories.import');
  return (
    <span className="text-sm text-fg-muted">
      {t('upload.export-hint')}{' '}
      <button
        type="button"
        className="font-medium text-link underline"
        onClick={() => void exportTree('csv', t('export-failed'))}
      >
        CSV
      </button>{' '}
      <button
        type="button"
        className="font-medium text-link underline"
        onClick={() => void exportTree('xlsx', t('export-failed'))}
      >
        XLSX
      </button>
    </span>
  );
}

function ProblemBanner({
  problem,
  onCheckAgain,
}: {
  readonly problem: ImportProblem;
  readonly onCheckAgain: (() => void) | undefined;
}) {
  const t = useTranslations('categories.import');
  const text = (() => {
    switch (problem.kind) {
      case 'stale':
        return t('problem.stale');
      case 'file-changed':
        return t('problem.file-changed');
      case 'has-errors':
        return t('problem.has-errors');
      case 'forbidden':
        return t('problem.forbidden');
      case 'claim-check':
        return t('problem.claim-check');
      case 'busy':
        return t('problem.busy');
      case 'columns':
        return t('problem.columns', {
          list: problem.fields
            .map((field) => `${field.path.replace(/^columns\./, '')}: ${columnCode(t, field.code)}`)
            .join('; '),
        });
      case 'file':
        return t(
          `problem.file.${problem.code.replace('.', '-')}` as never,
          {
            size:
              problem.maxBytes === null
                ? FALLBACK_MAX_MB
                : Math.round(problem.maxBytes / (1024 * 1024)),
          } as never,
        );
      default:
        return t('problem.unknown');
    }
  })();
  return (
    <Banner tone="critical">
      <span>{text}</span>
      {problem.kind === 'stale' && onCheckAgain !== undefined ? (
        <>
          {' '}
          <button type="button" className="font-medium underline" onClick={onCheckAgain}>
            {t('check-again')}
          </button>
        </>
      ) : null}
    </Banner>
  );
}

function columnCode(t: (key: never) => string, code: string): string {
  const known = [
    'column.blank',
    'column.duplicate',
    'column.missing',
    'column.unknown',
    'locale-unsupported',
  ];
  return known.includes(code) ? t(`column-code.${code.replace('.', '-')}` as never) : code;
}

function ResultTable({
  rows: body,
  filter,
  onFilter,
}: {
  readonly rows: DryRunBody;
  readonly filter: RowFilter;
  readonly onFilter: (next: RowFilter) => void;
}) {
  const t = useTranslations('categories.import');
  const list = visibleRows(body.rows, filter);
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={t('filter.label')} className="flex flex-wrap gap-2">
        {(['all', 'errors'] as const).map((value) => (
          <Button
            key={value}
            variant={filter === value ? 'primary' : 'secondary'}
            aria-pressed={filter === value}
            disabled={value === 'errors' && body.counts.error === 0}
            onClick={() => onFilter(value)}
          >
            {t(`filter.${value}`, {
              count: value === 'all' ? body.rows.length : body.counts.error,
            })}
          </Button>
        ))}
      </div>
      <Card flush>
        <div className="overflow-x-auto">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('table.caption')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr className="border-b border-line text-fg-muted">
                <th scope="col" className="w-20 px-4 py-3 text-start font-medium">
                  {t('table.row')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('table.category')}
                </th>
                <th scope="col" className="w-32 px-4 py-3 text-start font-medium">
                  {t('table.result')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('table.problem')}
                </th>
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {list.map((row) => (
                <tr key={row.rowNumber} className={CARD_TABLE.row}>
                  <td className={`${CARD_TABLE.cell} tabular-nums`}>{row.rowNumber}</td>
                  <td
                    className={`${CARD_TABLE.labelled} break-words font-mono text-sm`}
                    data-label={t('table.category')}
                  >
                    {row.slug === '' ? t('table.no-slug') : row.slug}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('table.result')}>
                    <Badge tone={ACTION_TONE[row.action]}>{t(`action.${row.action}`)}</Badge>
                  </td>
                  <td className={`${CARD_TABLE.labelled} text-fg`} data-label={t('table.problem')}>
                    {row.issues.length === 0 ? (
                      ''
                    ) : (
                      <ul className="m-0 list-none p-0">
                        {row.issues.map((issue) => (
                          <li key={`${issue.path}:${issue.code}`}>
                            {ROW_CODES.has(issue.code)
                              ? t(`row-code.${issue.code.replace('.', '-')}` as never)
                              : issue.code}
                            {issue.path === '' ? null : (
                              <span className="text-fg-muted"> ({issue.path})</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
