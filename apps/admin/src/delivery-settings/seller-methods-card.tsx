'use client';

import { ActionRow, Banner, Button, Card, CheckboxRow, Dialog, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { deliveryProblemOf } from './errors.ts';
import { METHODS, sellerMethodsPath, type Method, type SellerMethods } from './types.ts';

const P = 'sellerDelivery';

/**
 * The delivery methods one seller supports (on the admin seller page). The seller never sets
 * these: an admin does, for example for a seller without the capacity for instant delivery.
 * A method the Market has off stays off whatever is ticked here.
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
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const busy = useRef(false);

  const toggle = (method: Method, on: boolean) => {
    setChosen(METHODS.filter((m) => (m === method ? on : chosen.includes(m))));
  };

  /** What saving changes for this seller, in page order. */
  const changes = METHODS.flatMap((method) => {
    const was = saved.supported.includes(method);
    const now = chosen.includes(method);
    return was === now ? [] : [{ method, key: now ? 'on' : 'off' }];
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !canManage) return;
    setProblem(null);
    setNotice(false);
    if (changes.length === 0) void save();
    else setConfirm(true);
  }

  async function save() {
    busy.current = true;
    setPending(true);
    const result = await callApi<SellerMethods>(
      'PUT',
      sellerMethodsPath(saved.sellerId),
      { supported: chosen },
      csrfToken,
    );
    if (result.ok) {
      setSaved(result.body);
      setChosen(result.body.supported);
      toast.success(t(`${P}.saved`));
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
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
    busy.current = false;
    setPending(false);
  }

  return (
    <Card title={t(`${P}.title`)}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
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
        {canManage ? (
          <ActionRow>
            <Button type="submit" loading={pending}>
              {t(`${P}.save`)}
            </Button>
          </ActionRow>
        ) : null}
        <Dialog
          open={confirm}
          title={t(`${P}.confirm.title`)}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setConfirm(false)}>
                {t(`${P}.confirm.cancel`)}
              </Button>
              <Button
                onClick={() => {
                  setConfirm(false);
                  void save();
                }}
              >
                {t(`${P}.confirm.go`)}
              </Button>
            </>
          }
        >
          <p className="mb-3">{t(`${P}.confirm.intro`)}</p>
          <ul className="flex flex-col gap-3">
            {changes.map((change) => {
              const method = t(`deliverySettings.method.${change.method}`);
              return (
                <li key={change.method}>
                  <p>{t(`${P}.confirm.line.${change.key}`, { method })}</p>
                  <p className="text-sm text-fg-muted">
                    <span className="font-medium">{t(`${P}.confirm.sellers`)}: </span>
                    {t(`${P}.confirm.seller.${change.key}`, { method })}
                  </p>
                </li>
              );
            })}
          </ul>
        </Dialog>
      </form>
    </Card>
  );
}
