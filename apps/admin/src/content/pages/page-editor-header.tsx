'use client';

import { BackLink, Badge, Banner, Tabs } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstantInZone } from '../../shared/format.ts';
import { PageStatusBadge } from './page-labels.tsx';
import {
  PAGES_PATH,
  detailRef,
  isKnownTemplate,
  pagePath,
  settingsPagePath,
  type PageDetail,
} from './page-types.ts';

export type EditorTab = 'content' | 'settings';

/**
 * The top of every tab of the page editor: back link, title, address, status and the tab row.
 * `readOnly` says why the page takes no change (a note under the tabs).
 */
export function PageEditorHeader({
  page,
  tab,
  zone,
  canEdit,
}: {
  readonly page: PageDetail;
  readonly tab: EditorTab;
  /** The IANA zone dates are shown in. */
  readonly zone: string;
  readonly canEdit: boolean;
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
  const note = !canEdit
    ? t('read-only')
    : page.status === 'archived'
      ? t('archived-note')
      : page.editLevel === 'locked'
        ? t('locked-note')
        : null;
  return (
    <>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <BackLink href={PAGES_PATH} label={t('back')} />
        <h1 className="break-words text-2xl font-semibold">{page.title}</h1>
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
        ]}
      />
      {note === null ? null : <Banner tone="info">{note}</Banner>}
    </>
  );
}
