'use client';

import { Banner, Card, CheckboxRow, type SectionResult } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import {
  isNoteFailure,
  ReviewNoteField,
  trimmedNote,
  useSentForReview,
} from '../shared/review-note.tsx';
import { useSellerSection } from '../sellers/seller-edit-form.tsx';
import { deliveryProblemOf } from './errors.ts';
import { METHODS, sellerMethodsPath, type Method, type SellerMethods } from './types.ts';

const P = 'sellerDelivery';

/**
 * The delivery methods one seller supports (on the admin seller page). The seller never sets
 * these: an admin does, for example for a seller without the capacity for instant delivery.
 * A method the Market has off stays off whatever is ticked here. Saving is one part of the
 * seller page's save bar (`SellerEditForm`), whose confirm lists what changes for buyers.
 */
export function SellerMethodsCard({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: SellerMethods;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const [saved, setSaved] = useState(initial);
  const [chosen, setChosen] = useState<readonly Method[]>(initial.supported);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const sentForReview = useSentForReview();
  // The note is asked only where the view says a change is reviewed.
  const reviewed = saved.review?.reviewed === true;

  const toggle = (method: Method, on: boolean) => {
    setChosen(METHODS.filter((m) => (m === method ? on : chosen.includes(m))));
  };

  /** What saving changes for this seller, in page order. */
  const changes = METHODS.flatMap((method) => {
    const was = saved.supported.includes(method);
    const now = chosen.includes(method);
    return was === now ? [] : [{ method, key: now ? 'on' : 'off' }];
  });

  function check(): boolean {
    setProblem(null);
    setNotice(false);
    if (reviewed && trimmedNote(note) === null) {
      setNoteError('required');
      return false;
    }
    return true;
  }

  async function save(): Promise<SectionResult> {
    const sent = reviewed ? trimmedNote(note) : null;
    if (reviewed && sent === null) {
      setNoteError('required');
      return 'failed';
    }
    setNoteError(null);
    const result = await callApi<SellerMethods & { request?: unknown }>(
      'PUT',
      sellerMethodsPath(saved.sellerId),
      { supported: chosen, ...(sent === null ? {} : { note: sent }) },
      csrfToken,
    );
    if (result.ok) {
      const { request, ...rest } = result.body;
      sentForReview({ request });
      setSaved(rest);
      setChosen(rest.supported);
      setNote('');
      return 'saved';
    }
    if (result.failure.status === 401) return section.signedOut();
    if (isNoteFailure(result.failure)) setNoteError('rejected');
    else {
      const key = deliveryProblemOf(result.failure);
      if (key === 'conflict') {
        // Changed by someone else first: show what is stored now and let the admin decide again.
        const fresh = await callApi<SellerMethods>('GET', sellerMethodsPath(saved.sellerId));
        if (fresh.ok) {
          setSaved(fresh.body);
          setChosen(fresh.body.supported);
          setNotice(true);
        } else setProblem(key);
      } else setProblem(key);
    }
    return 'failed';
  }

  const section = useSellerSection('delivery-methods', {
    dirty: canManage && changes.length > 0,
    title: t(`${P}.title`),
    lines: changes.map((change) => {
      const method = t(`deliverySettings.method.${change.method}`);
      return `${t(`${P}.confirm.line.${change.key}`, { method })} ${t(`${P}.confirm.seller.${change.key}`, { method })}`;
    }),
    check,
    save,
    savedMessage: () => t(`${P}.saved`),
    discard: () => {
      setChosen(saved.supported);
      setNote('');
      setNoteError(null);
      setProblem(null);
    },
  });

  return (
    <Card title={t(`${P}.title`)}>
      <div className="flex flex-col gap-4">
        {canManage ? null : <Banner tone="info">{t(`${P}.viewer-only`)}</Banner>}
        <p className="text-sm text-fg-muted">{t(`${P}.intro`)}</p>
        {notice ? <Banner tone="attention">{t(`${P}.notice.reloaded`)}</Banner> : null}
        {problem === null ? null : <Banner tone="critical">{t(`${P}.error.${problem}`)}</Banner>}
        <div className="flex flex-col gap-3">
          {METHODS.map((method) => {
            const marketOff = !saved.platformEnabled[method];
            const name = t(`deliverySettings.method.${method}`);
            return (
              <CheckboxRow
                key={method}
                name={`supports-${method}`}
                label={marketOff ? t(`${P}.method-market-off`, { method: name }) : name}
                {...(marketOff ? { help: t(`${P}.market-off-help`) } : {})}
                checked={chosen.includes(method)}
                disabled={!canManage || marketOff}
                onChange={(event) => toggle(method, event.target.checked)}
              />
            );
          })}
        </div>
        {reviewed && canManage ? (
          <ReviewNoteField
            value={note}
            onChange={(next) => {
              setNote(next);
              setNoteError(null);
            }}
            error={noteError ?? undefined}
          />
        ) : null}
      </div>
    </Card>
  );
}
