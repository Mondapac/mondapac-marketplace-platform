'use client';

import { Badge, Banner, Button, CARD_TABLE, type BadgeTone, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { shortInstantInZone } from '../../shared/format.ts';
import { SlideEditorHeader } from './slide-editor-header.tsx';
import { SlideConfirmDialog } from './slide-dialogs.tsx';
import { MAX_VERSIONS_SHOWN, type SlideDetail } from './slide-types.ts';

type VersionState = 'live' | 'draft' | 'earlier';

const STATE_TONE: Record<VersionState, BadgeTone> = {
  live: 'success',
  draft: 'attention',
  earlier: 'neutral',
};

/**
 * The Versions tab of a slide: every saved version, newest first, with its number, when it was
 * saved and whether it is the live version, the open draft or an earlier one. Restore copies a
 * version into the draft as a new version (storefront.slide.edit); the earlier one is kept. The
 * API lists no author for a version, so none is shown.
 */
export function SlideVersions({
  slide,
  canEdit,
  canPause = false,
  canPublish = false,
  csrfToken,
  zone,
}: {
  readonly slide: SlideDetail;
  readonly canEdit: boolean;
  readonly canPause?: boolean;
  readonly canPublish?: boolean;
  readonly csrfToken: string;
  /** The IANA zone dates are shown in. */
  readonly zone: string;
}) {
  const t = useTranslations('content.slides.versions');
  const locale = useLocale();
  const router = useRouter();
  const [detail, setDetail] = useState<SlideDetail>(slide);
  const [restoring, setRestoring] = useState<{ id: string; versionNo: number } | null>(null);
  const archived = detail.status === 'archived';
  const editable = canEdit && !archived;

  const stateOf = (id: string): VersionState =>
    detail.live?.id === id ? 'live' : detail.draft?.id === id ? 'draft' : 'earlier';

  return (
    <div className="flex flex-col gap-4">
      <SlideEditorHeader
        slide={detail}
        tab="versions"
        commands={{
          gates: { edit: canEdit, pause: canPause, publish: canPublish },
          csrfToken,
          zone,
          onChange: setDetail,
        }}
      />
      {!canEdit ? <Banner tone="info">{t('read-only')}</Banner> : null}
      {canEdit && archived ? <Banner tone="info">{t('archived')}</Banner> : null}
      {detail.versions.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-6 text-sm text-fg-muted">
          {t('none')}
        </p>
      ) : (
        <>
          <p className="text-sm text-fg-muted">
            {t('count', { count: detail.versions.length })} {t('note')}
          </p>
          <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
            <table className={`${CARD_TABLE.table} lg:table-fixed`}>
              <caption className="sr-only">{t('caption')}</caption>
              <colgroup className="max-lg:hidden">
                <col className="w-32" />
                <col />
                <col className="w-48" />
                <col className="w-40" />
              </colgroup>
              <thead className={CARD_TABLE.head}>
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('col.version')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('col.saved')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('col.state')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('col.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className={CARD_TABLE.body}>
                {detail.versions.map((version) => {
                  const state = stateOf(version.id);
                  return (
                    <tr key={version.id} className={CARD_TABLE.row}>
                      <th scope="row" className={`${CARD_TABLE.cell} text-start font-medium`}>
                        {t('version', { version: version.versionNo })}
                      </th>
                      <td className={CARD_TABLE.labelled} data-label={t('col.saved')}>
                        <span>
                          {shortInstantInZone(version.createdAt, locale, zone)}
                          {version.approvedAt === null ? null : (
                            <span className="block text-xs text-fg-muted">
                              {t('approved', {
                                when: shortInstantInZone(version.approvedAt, locale, zone),
                              })}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={CARD_TABLE.corner}>
                        <Badge tone={STATE_TONE[state]}>
                          {state === 'draft'
                            ? t(detail.pending ? 'state.draft-pending' : 'state.draft')
                            : t(`state.${state}`)}
                        </Badge>
                      </td>
                      <td className={`${CARD_TABLE.cell} max-lg:col-span-2 max-lg:pt-1`}>
                        {editable && state !== 'draft' ? (
                          <Button
                            variant="secondary"
                            onClick={() =>
                              setRestoring({ id: version.id, versionNo: version.versionNo })
                            }
                          >
                            {t('restore')}
                            <span className="sr-only">
                              {' '}
                              {t('restore-for', { version: version.versionNo })}
                            </span>
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {detail.versions.length >= MAX_VERSIONS_SHOWN ? (
            <p className="text-sm text-fg-muted">{t('limit', { count: MAX_VERSIONS_SHOWN })}</p>
          ) : null}
        </>
      )}
      {editable ? (
        <SlideConfirmDialog
          kind="restore"
          open={restoring !== null}
          slide={{ id: detail.id, name: detail.internalName }}
          {...(restoring === null
            ? {}
            : { versionId: restoring.id, versionNo: restoring.versionNo })}
          placements={[]}
          csrfToken={csrfToken}
          onClose={() => setRestoring(null)}
          onDone={(next) => {
            const from = restoring?.versionNo ?? 0;
            setRestoring(null);
            setDetail(next);
            toast.success(t('done', { from, to: next.draft?.versionNo ?? 0 }));
          }}
          onStale={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}
