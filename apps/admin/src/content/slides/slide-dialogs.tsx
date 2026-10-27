'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { usePositionLabel } from './slide-labels.tsx';
import type { Finding } from './slide-commands.ts';
import type { CommandProblem } from './use-slide-command.ts';
import { useSlideCommand } from './use-slide-command.ts';
import type { SlideCommand, SlideDetail, SlidePlacement } from './slide-types.ts';

/** The refusal of a command as a banner; what the system found wrong is listed under it. */
export function CommandProblemView({ problem }: { readonly problem: CommandProblem }) {
  const t = useTranslations('content.slides.dialog');
  const positionLabel = usePositionLabel();
  const scopes = useTranslations('content.slides.placement.scope');
  const placeOf = (finding: Finding): string => {
    const placement = finding.placement;
    if (placement === null) return '';
    const base = positionLabel(placement.position);
    return placement.scope === 'all' ? base : `${base}, ${scopes(placement.scope)}`;
  };
  // A refused position or scope that cannot be named (the list has no placements) is left out:
  // the message above it already says that a position is full.
  const listed = problem.findings.filter(
    (finding) => finding.kind === 'link' || finding.placement !== null,
  );
  return (
    <Banner tone="critical">
      <p>{t(`problem.${problem.message}`)}</p>
      {listed.length === 0 ? null : (
        <ul className="mt-2 list-disc ps-5">
          {listed.map((finding, index) => (
            <li key={index} className="break-words">
              {t(`findings.${finding.kind}`, { place: placeOf(finding) })}
            </li>
          ))}
        </ul>
      )}
    </Banner>
  );
}

/** The commands that only need a yes: each has its own words under `content.slides.dialog.<kind>`. */
export type ConfirmKind = Extract<SlideCommand, 'pause' | 'resume' | 'archive' | 'restore'>;

const DESTRUCTIVE: ReadonlySet<ConfirmKind> = new Set(['archive']);

/**
 * Pause, resume, archive and restore, each behind one confirmation. The panel shows the control
 * only to a holder of the key; the API checks it again.
 */
export function SlideConfirmDialog({
  kind,
  open,
  slide,
  versionId,
  versionNo,
  placements,
  csrfToken,
  onClose,
  onDone,
  onStale,
}: {
  readonly kind: ConfirmKind;
  readonly open: boolean;
  readonly slide: { readonly id: string; readonly name: string };
  /** Restore only: the version to copy into the draft. */
  readonly versionId?: string;
  readonly versionNo?: number;
  /** The placements a resume checks against the maximums, to name a full position. */
  readonly placements: readonly SlidePlacement[];
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (detail: SlideDetail) => void;
  /** The slide changed meanwhile and the dialog was closed: read it again. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('content.slides.dialog');
  const command = useSlideCommand(csrfToken);
  const { reset } = command;
  const values = { name: slide.name, version: versionNo ?? 0 };

  // A closed dialog starts clean next time: no old refusal.
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const stale = command.problem?.stale === true;
  function close() {
    if (command.pending) return;
    const wasStale = stale;
    onClose();
    if (wasStale) onStale();
  }

  async function confirm() {
    const body = kind === 'restore' ? { versionId: versionId ?? '' } : {};
    const detail = await command.run(slide.id, kind, body, placements);
    if (detail !== null) onDone(detail);
  }

  return (
    <Dialog
      open={open}
      title={t(`${kind}.title`, values)}
      onClose={close}
      actions={
        stale ? (
          <Button onClick={close}>{t('close')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={command.pending}>
              {t('cancel')}
            </Button>
            <Button
              variant={DESTRUCTIVE.has(kind) ? 'destructive' : 'primary'}
              loading={command.pending}
              onClick={() => void confirm()}
            >
              {t(`${kind}.action`)}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <p>{t(`${kind}.body`, values)}</p>
        {t.has(`${kind}.note`) ? <p>{t(`${kind}.note`, values)}</p> : null}
        {command.problem === null ? null : <CommandProblemView problem={command.problem} />}
      </div>
    </Dialog>
  );
}
