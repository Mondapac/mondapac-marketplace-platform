'use client';

import { BackLink, Badge, Banner, Tabs } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { shortInstantInZone } from '../../shared/format.ts';
import { PageStatusBadge } from './page-labels.tsx';
import {
  PAGES_PATH,
  detailRef,
  isKnownTemplate,
  pagePath,
  settingsPagePath,
  versionsPagePath,
  type PageDetail,
} from './page-types.ts';

export type EditorTab = 'content' | 'settings' | 'versions';

/**
 * The top of every tab of the page editor: back link, title, address, status and the tab row.
 * `readOnly` says why the page takes no change (a note under the tabs).
 */
export function PageEditorHeader({
  page,
  tab,
  zone,
  canEdit,
  actions,
}: {
  readonly page: PageDetail;
  readonly tab: EditorTab;
  /** The IANA zone dates are shown in. */
  readonly zone: string;
  readonly canEdit: boolean;
  /** Publish and Archive, when the person may use them. */
  readonly actions?: ReactNode;
}) {
  const t = useTranslations('content.pages.editor');
  const templates = useTranslations('content.pages.template');
  const list = useTranslations('content.pages.list');
  const locale = useLocale();
  const ref = detailRef(page);
  const template = page.templateKey.startsWith('system.')
    ? templates('system')
    : isKnownTemplate(page.templateKey)
      ? templates(page.templateKey)
      : page.templateKey;
  const note =
    page.status === 'archived'
      ? t('archived-note')
      : !canEdit
        ? t('read-only')
        : page.editLevel === 'locked'
          ? t('locked-note')
          : null;
  return (
    <>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <BackLink href={PAGES_PATH} label={t('back')} />
        <div className="flex w-full flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h1 className="min-w-0 break-words text-2xl font-semibold">{page.title}</h1>
          {actions === undefined ? null : (
            <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <PageStatusBadge status={page.status} />
          {page.hasDraft && page.status !== 'draft' ? (
            <Badge tone="attention">{list('unpublished-changes')}</Badge>
          ) : null}
          <code className="break-all text-xs">{page.path}</code>
          <span>{template}</span>
          {page.publishedAt === null ? null : (
            <span>
              {t('published-at', { when: shortInstantInZone(page.publishedAt, locale, zone) })}
            </span>
          )}
        </div>
      </div>
      <Tabs
        label={t('tabs')}
        activeId={tab}
        items={[
          { id: 'content', href: pagePath(ref), label: t('tab-content') },
          { id: 'settings', href: settingsPagePath(ref), label: t('tab-settings') },
          { id: 'versions', href: versionsPagePath(ref), label: t('tab-versions') },
        ]}
      />
      {note === null ? null : <Banner tone="info">{note}</Banner>}
    </>
  );
}
