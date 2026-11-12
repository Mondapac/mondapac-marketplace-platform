'use client';

import { Badge, Banner, Button, Dialog, toast, type BadgeTone } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatInstantInZone } from '../../shared/format.ts';
import { PageActions } from './page-actions.tsx';
import { PageEditorHeader } from './page-editor-header.tsx';
import {
  detailRef,
  isReadOnlyPage,
  restorePath,
  type PageDetail,
  type PageVersion,
} from './page-types.ts';
import { STALE_CODES, usePageCommand, useProblemText } from './use-page-command.ts';

const STATE_TONE: Readonly<Record<string, BadgeTone>> = {
  draft: 'attention',
  published: 'success',
  retired: 'neutral',
};

/**
 * The Versions tab: the draft and every version buyers have seen, newest first. An earlier version
 * is copied into the draft (it replaces the draft's modules); buyers see nothing until the page is
 * published. The restore key is the edit key; no author is shown (decision A).
 */
export function PageVersions({
  page,
  canEdit,
  canPublish,
  canArchive,
  csrfToken,
  zone,
}: {
  readonly page: PageDetail;
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  readonly canArchive: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('content.pages.versions');
  const locale = useLocale();
  const router = useRouter();
  const problemText = useProblemText();
  const command = usePageCommand(csrfToken);
  const [restoring, setRestoring] = useState<PageVersion | null>(null);

  const readOnly = isReadOnlyPage(page, canEdit);
  const rows = [...page.versions].sort((a, b) => b.versionNo - a.versionNo);
  const problem = command.problem;
  const stale =
    problem !== null &&
    (STALE_CODES.has(problem.code) || problem.code === 'storefront.version-not-found');

  function close() {
    command.reset();
    setRestoring(null);
  }

  async function restore() {
    if (restoring === null) return;
    const result = await command.run('POST', restorePath(detailRef(page)), {
      versionId: restoring.id,
    });
    if (result === null || !result.ok) return;
    toast.success(t('restored', { n: restoring.versionNo }));
    setRestoring(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <PageEditorHeader
        page={page}
        tab="versions"
        zone={zone}
        canEdit={canEdit}
        actions={
          <PageActions
            page={page}
            canPublish={canPublish}
            canArchive={canArchive}
            csrfToken={csrfToken}
          />
        }
      />
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-sm text-fg-muted">
          {t('empty')}
        </p>
      ) : (
        <ol aria-label={t('list')} className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((version) => (
            <li
              key={version.id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-line bg-surface p-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t('version', { n: version.versionNo })}</span>
                  <Badge tone={STATE_TONE[version.state] ?? 'neutral'}>
                    {t(
                      version.state === 'draft' ||
                        version.state === 'published' ||
                        version.state === 'retired'
                        ? `state-${version.state}`
                        : 'state-unknown',
                    )}
                  </Badge>
                </div>
                <p className="text-sm text-fg-muted">
                  {version.publishedAt === null
                    ? t('saved-at', { when: formatInstantInZone(version.createdAt, locale, zone) })
                    : t('published-on', {
                        when: formatInstantInZone(version.publishedAt, locale, zone),
                      })}
                </p>
              </div>
              {readOnly || version.state === 'draft' ? null : (
                <Button
                  variant="secondary"
                  aria-label={t('restore-label', { n: version.versionNo })}
                  disabled={command.pending}
                  onClick={() => {
                    command.reset();
                    setRestoring(version);
                  }}
                >
                  {t('restore')}
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {restoring === null ? null : (
        <Dialog
          open
          title={t('restore-title', { n: restoring.versionNo })}
          onClose={close}
          actions={
            <>
              <Button variant="secondary" onClick={close}>
                {t('cancel')}
              </Button>
              {stale ? (
                <Button
                  onClick={() => {
                    close();
                    router.refresh();
                  }}
                >
                  {t('reload')}
                </Button>
              ) : (
                <Button loading={command.pending} onClick={() => void restore()}>
                  {t('restore-confirm')}
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {problem === null ? null : (
              <Banner tone="critical">
                {problem.code === 'storefront.version-not-found'
                  ? t('error-gone')
                  : problemText(problem)}
              </Banner>
            )}
            <p>{t('restore-body')}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
