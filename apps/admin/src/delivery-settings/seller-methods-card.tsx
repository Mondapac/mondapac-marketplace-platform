'use client';

import { ActionRow, Badge, Banner, Button, Card, CheckboxRow } from '@mondapac/ui';
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
  const [done, setDone] = useState(false);
  const busy = useRef(false);

  const toggle = (method: Method, on: boolean) => {
    setDone(false);
    setChosen(METHODS.filter((m) => (m === method ? on : chosen.includes(m))));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setDone(false);
    const result = await callApi<SellerMethods>(
      'PUT',
      sellerMethodsPath(saved.sellerId),
      { supported: chosen },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setSaved(result.body);
      setChosen(result.body.supported);
      setDone(true);
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(deliveryProblemOf(result.failure));
  }

  return (
    <Card title={t(`${P}.title`)}>
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
        <p className="text-sm text-fg-muted">{t(`${P}.intro`)}</p>
        {done ? <Banner tone="success">{t(`${P}.saved`)}</Banner> : null}
        {problem === null ? null : <Banner tone="critical">{t(`${P}.error.${problem}`)}</Banner>}
        <div className="flex flex-col gap-3">
          {METHODS.map((method) => (
            <div key={method} className="flex flex-wrap items-start justify-between gap-2">
              <CheckboxRow
                name={`supports-${method}`}
                label={t(`deliverySettings.method.${method}`)}
                checked={chosen.includes(method)}
                disabled={!canManage}
                onChange={(event) => toggle(method, event.target.checked)}
              />
              {saved.platformEnabled[method] ? null : (
                <Badge tone="neutral">{t(`${P}.platform-off`)}</Badge>
              )}
            </div>
          ))}
        </div>
        {canManage ? (
          <ActionRow>
            <Button type="submit" loading={pending}>
              {t(`${P}.save`)}
            </Button>
          </ActionRow>
        ) : null}
      </form>
    </Card>
  );
}
