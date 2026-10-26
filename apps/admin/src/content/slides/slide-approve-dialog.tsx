'use client';

import { Banner, Button, CheckboxRow, Dialog } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useState } from 'react';
import { shortInstantInZone } from '../../shared/format.ts';
import { formOf } from './slide-form.ts';
import { MAX_CHANGE_LINES, changesOf, type ChangeWords } from './slide-changes.ts';
import { CommandProblemView } from './slide-dialogs.tsx';
import { usePositionLabel } from './slide-labels.tsx';
import { SlidePreview } from './slide-preview.tsx';
import type { SlideDetail } from './slide-types.ts';
import { useSlideCommand } from './use-slide-command.ts';

/**
 * Approve the draft an editor sent (storefront.slide.publish, a platform admin). It shows the
 * draft as buyers would see it, what changes against the live version, and what the system
 * checks when the draft is approved. The API reports its checks only as the answer to the
 * approval, so a finding is listed after Approve is pressed and the draft stays unapproved.
 * `versionNo` goes with the request: if the editor changed the draft meanwhile, it is refused.
 */
export function SlideApproveDialog({
  open,
  slide,
  zone,
  csrfToken,
  onClose,
  onDone,
  onStale,
}: {
  readonly open: boolean;
  readonly slide: SlideDetail;
  /** The IANA zone the window is shown in. */
  readonly zone: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (detail: SlideDetail) => void;
  readonly onStale: () => void;
}) {
  const t = useTranslations('content.slides.dialog.approve');
  const td = useTranslations('content.slides.dialog');
  const tf = useTranslations('content.slides.dialog.approve.field');
  const links = useTranslations('content.slides.editor.link');
  const scopes = useTranslations('content.slides.placement.scope');
  const images = useTranslations('content.slides.editor.image-key');
  const locale = useLocale();
  const positionLabel = usePositionLabel();
  const command = useSlideCommand(csrfToken);
  const { reset } = command;
  const [sure, setSure] = useState(false);
  const [sureError, setSureError] = useState(false);
  const changesId = useId();
  const checksId = useId();
  const sureErrorId = useId();
  const draft = slide.draft;

  useEffect(() => {
    if (!open) {
      reset();
      setSure(false);
      setSureError(false);
    }
  }, [open, reset]);

  const words: ChangeWords = useMemo(
    () => ({
      position: positionLabel,
      scope: (placement) => scopes(placement.scope),
      window: (startsAt, endsAt) =>
        t('window', {
          from: shortInstantInZone(startsAt, locale, zone),
          to: shortInstantInZone(endsAt, locale, zone),
          zone,
        }),
      link: (type) => (links.has(type) ? links(type) : type),
    }),
    [positionLabel, scopes, links, t, locale, zone],
  );
  const changes = useMemo(
    () => (draft === null ? [] : changesOf(slide.live, draft, words)),
    [draft, slide.live, words],
  );
  const shown = changes.slice(0, MAX_CHANGE_LINES);
  const hidden = changes.length - shown.length;

  const stale = command.problem?.stale === true;
  function close() {
    if (command.pending) return;
    const wasStale = stale;
    onClose();
    if (wasStale) onStale();
  }

  async function approve() {
    if (draft === null) return;
    if (!sure) {
      setSureError(true);
      return;
    }
    const detail = await command.run(
      slide.id,
      'approve',
      { versionNo: draft.versionNo },
      draft.placements,
    );
    if (detail !== null) onDone(detail);
  }

  function lineOf(change: (typeof changes)[number]): string {
    const values: Record<string, string> = { ...change.values };
    if (values.field !== undefined) values.field = tf(values.field);
    if (change.id === 'image' && values.image !== undefined) {
      values.image = images.has(values.image) ? images(values.image) : values.image;
    }
    return t(`change.${change.id}`, values);
  }

  return (
    <Dialog
      open={open}
      title={t('title', { name: slide.internalName })}
      onClose={close}
      actions={
        stale ? (
          <Button onClick={close}>{td('close')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={command.pending}>
              {td('cancel')}
            </Button>
            <Button loading={command.pending} onClick={() => void approve()}>
              {t('action')}
            </Button>
          </>
        )
      }
    >
      {draft === null ? (
        <Banner tone="info">{t('no-draft')}</Banner>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            {t('sent', {
              version: draft.versionNo,
              when: shortInstantInZone(draft.createdAt, locale, zone),
            })}
          </p>
          <SlidePreview compact form={formOf(slide)} tone={draft.content?.textTone ?? 'light'} />
          <section aria-labelledby={changesId} className="flex flex-col gap-2">
            <h3 id={changesId} className="text-sm font-semibold text-fg">
              {t('changes')}
            </h3>
            {shown.length === 0 ? (
              <p className="text-sm">{t('no-changes')}</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
                {shown.map((change, index) => (
                  <li key={index} className="break-words">
                    {lineOf(change)}
                  </li>
                ))}
              </ul>
            )}
            {hidden > 0 ? (
              <p className="text-sm text-fg-muted">{t('more', { count: hidden })}</p>
            ) : null}
          </section>
          <section aria-labelledby={checksId} className="flex flex-col gap-2">
            <h3 id={checksId} className="text-sm font-semibold text-fg">
              {t('checks')}
            </h3>
            <p className="text-sm">{t('checks-body')}</p>
          </section>
          <div className="flex flex-col gap-1">
            <CheckboxRow
              label={t('confirm')}
              checked={sure}
              aria-invalid={sureError && !sure ? true : undefined}
              aria-describedby={sureError && !sure ? sureErrorId : undefined}
              onChange={(event) => {
                setSure(event.target.checked);
                setSureError(false);
              }}
            />
            {sureError && !sure ? (
              <p id={sureErrorId} role="alert" className="ps-7 text-sm text-critical-fg">
                {t('confirm-needed')}
              </p>
            ) : null}
          </div>
          {command.problem === null ? null : <CommandProblemView problem={command.problem} />}
        </div>
      )}
    </Dialog>
  );
}
