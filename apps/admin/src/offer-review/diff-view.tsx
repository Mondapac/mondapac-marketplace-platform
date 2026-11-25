'use client';

import { Badge } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { descriptionDiffs, diffText, tagDiff, type Part } from './text-diff.ts';
import { typeLabel, type ChangeLive, type ChangeRow } from './types.ts';

/** One side's text with removed or added words marked by style, a sign and a hidden word. */
function Marked({ parts }: { readonly parts: readonly Part[] }) {
  const t = useTranslations('offer-review.diff');
  if (parts.length === 0) return <span className="text-fg-muted">{t('empty')}</span>;
  return (
    <span className="break-words whitespace-pre-line">
      {parts.map((part, index) =>
        part.kind === 'same' ? (
          <span key={index}>{part.text}</span>
        ) : part.kind === 'removed' ? (
          <del key={index} className="rounded-sm bg-critical-bg text-critical-fg">
            <span className="sr-only">{t('removed')}: </span>
            <span aria-hidden="true">− </span>
            {part.text}
          </del>
        ) : (
          <ins key={index} className="rounded-sm bg-success-bg text-success-fg no-underline">
            <span className="sr-only">{t('added')}: </span>
            <span aria-hidden="true">+ </span>
            {part.text}
          </ins>
        ),
      )}
    </span>
  );
}

/** The two columns of one field: Live on the left (above on a phone), Proposed on the right. */
function Pair({
  label,
  live,
  proposed,
}: {
  readonly label: string;
  readonly live: React.ReactNode;
  readonly proposed: React.ReactNode;
}) {
  const t = useTranslations('offer-review.diff');
  return (
    <section aria-label={label} className="rounded-md border border-line">
      <h3 className="border-b border-line bg-muted px-3 py-2 text-sm font-semibold">{label}</h3>
      <div className="grid gap-px bg-line sm:grid-cols-2">
        <div className="bg-surface p-3">
          <p className="mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">
            {t('live')}
          </p>
          {live}
        </div>
        <div className="bg-surface p-3">
          <p className="mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">
            {t('proposed')}
          </p>
          {proposed}
        </div>
      </div>
    </section>
  );
}

/**
 * The held edit of a live Offer against what is live now (the Live | Proposed diff): one block per
 * field the change holds. Without the live values (the Offer could not be read) the proposed side
 * shows alone and says so.
 */
export function ChangeDiff({ change }: { readonly change: ChangeRow }) {
  const t = useTranslations('offer-review.diff');
  const th = useTranslations('offer-review.handling');
  const live: ChangeLive | null = change.live;
  const has = (field: string) => change.fields.includes(field);
  return (
    <div className="flex flex-col gap-3">
      {live === null ? (
        <p role="status" className="text-sm text-fg-muted">
          {t('live-unavailable')}
        </p>
      ) : null}
      {has('description') && change.proposedDescription !== null
        ? (() => {
            const rows = descriptionDiffs(live?.description ?? {}, change.proposedDescription);
            const changed = rows.filter((row) => row.changed);
            const same = rows.filter((row) => !row.changed);
            return (
              <>
                {changed.map((row) => {
                  const parts = diffText(row.live, row.proposed);
                  return (
                    <Pair
                      key={row.locale}
                      label={t('description', { locale: row.locale })}
                      live={
                        live === null ? (
                          <span className="text-fg-muted">{t('unknown')}</span>
                        ) : (
                          <Marked parts={parts.live} />
                        )
                      }
                      proposed={<Marked parts={parts.proposed} />}
                    />
                  );
                })}
                {same.length === 0 ? null : (
                  <details className="rounded-md border border-line px-3 py-2 text-sm">
                    <summary className="cursor-pointer font-medium">
                      {t('unchanged', { count: same.length })}
                    </summary>
                    <ul className="mt-2 flex list-none flex-col gap-2 p-0">
                      {same.map((row) => (
                        <li key={row.locale}>
                          <span className="me-2 text-fg-muted">{row.locale}</span>
                          <span className="break-words whitespace-pre-line">{row.proposed}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            );
          })()
        : null}
      {has('handling') && change.proposedHandling !== null ? (
        <Pair
          label={t('handling')}
          live={
            live === null ? (
              <span className="text-fg-muted">{t('unknown')}</span>
            ) : live.handling === null ? (
              <Badge tone="neutral">{t('not-set')}</Badge>
            ) : (
              <Badge tone="neutral">{th(live.handling)}</Badge>
            )
          }
          proposed={<Badge tone="info">{th(change.proposedHandling)}</Badge>}
        />
      ) : null}
      {has('tags')
        ? (() => {
            const tags = tagDiff(live?.tagTypes ?? [], change.proposedTagTypes);
            return (
              <Pair
                label={t('tags')}
                live={
                  live === null ? (
                    <span className="text-fg-muted">{t('unknown')}</span>
                  ) : live.tagTypes.length === 0 ? (
                    <span className="text-fg-muted">{t('no-tags')}</span>
                  ) : (
                    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                      {live.tagTypes.map((code) => (
                        <li key={code}>
                          <Badge tone="neutral">{typeLabel(code)}</Badge>
                          {tags.removed.includes(code) ? (
                            <span className="ms-1 text-xs text-fg-muted">
                              <span aria-hidden="true">−</span>
                              <span className="sr-only">{t('removed')}</span>
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )
                }
                proposed={
                  <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                    {[...tags.kept, ...tags.added].map((code) => (
                      <li key={code}>
                        <Badge tone={tags.added.includes(code) ? 'success' : 'neutral'}>
                          {tags.added.includes(code) ? (
                            <>
                              <span aria-hidden="true">+</span>
                              <span className="sr-only">{t('added')}: </span>
                            </>
                          ) : null}
                          {typeLabel(code)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                }
              />
            );
          })()
        : null}
    </div>
  );
}
