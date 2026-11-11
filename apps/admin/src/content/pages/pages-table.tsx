import { Badge, CARD_TABLE } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstantInZone } from '../../shared/format.ts';
import { PageStatusBadge } from './page-labels.tsx';
import {
  isKnownEditLevel,
  isKnownTemplate,
  pagePath,
  pageRef,
  type PageSummary,
} from './page-types.ts';

/**
 * The pages of the Market: title, buyer-site address, template, editing level, status and the
 * last publish. Below 1024 px every row is a card (the shared CARD_TABLE).
 */
export function PagesTable({
  rows,
  zone,
}: {
  readonly rows: readonly PageSummary[];
  /** The IANA zone dates are shown in. */
  readonly zone: string;
}) {
  const t = useTranslations('content.pages.list');
  const templates = useTranslations('content.pages.template');
  const levels = useTranslations('content.pages.level');
  const locale = useLocale();
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-240 lg:table-fixed`}>
        <caption className="sr-only">{t('caption')}</caption>
        <colgroup className="max-lg:hidden">
          <col className="w-[24%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
          <col className="w-[12%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.page')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.address')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.template')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium lg:px-2">
              {t('col.editing')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium lg:px-2">
              {t('col.status')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.published')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((page) => {
            const ref = pageRef(page);
            const template = page.templateKey.startsWith('system.')
              ? templates('system')
              : isKnownTemplate(page.templateKey)
                ? templates(page.templateKey)
                : page.templateKey;
            return (
              <tr key={ref ?? page.path} className={CARD_TABLE.row}>
                <td className={CARD_TABLE.cell}>
                  {ref === null ? (
                    <span className="font-medium">{page.title}</span>
                  ) : (
                    <a className="break-words font-medium text-link underline" href={pagePath(ref)}>
                      {page.title}
                    </a>
                  )}
                  {page.kind === 'system' ? (
                    <p className="text-xs text-fg-muted">{t('system')}</p>
                  ) : null}
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.address')}>
                  <code className="break-all text-xs">{page.path}</code>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.template')}>
                  {template}
                </td>
                <td className={`${CARD_TABLE.labelled} lg:px-2`} data-label={t('col.editing')}>
                  {isKnownEditLevel(page.editLevel) ? levels(page.editLevel) : page.editLevel}
                </td>
                <td className={`${CARD_TABLE.corner} lg:px-2`}>
                  <div className="flex flex-wrap items-center gap-1">
                    <PageStatusBadge status={page.status} />
                    {page.hasDraft && page.status !== 'draft' ? (
                      <Badge tone="attention">{t('unpublished-changes')}</Badge>
                    ) : null}
                  </div>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.published')}>
                  {page.publishedAt === null ? (
                    <span className="text-fg-muted">{t('never')}</span>
                  ) : (
                    shortInstantInZone(page.publishedAt, locale, zone)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
