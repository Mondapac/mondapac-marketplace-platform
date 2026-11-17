'use client';

import { Banner, Button, Dialog, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { taxProblemOf } from './errors.ts';
import { percentOf, TAX_ACTIVE_PATH, TAX_STRATEGIES_PATH, type TaxStrategy } from './types.ts';

export type ConfirmAction =
  | { readonly kind: 'activate'; readonly strategy: TaxStrategy }
  | { readonly kind: 'built-in' }
  | { readonly kind: 'delete'; readonly strategy: TaxStrategy };

/**
 * The confirmation of Activate, Back to built-in and Delete. Activating applies to new orders only
 * (frozen tax never changes) and is audited by the API; deleting the strategy in force is refused
 * with `tax.strategy-active`, and a strategy that is gone refreshes the list.
 */
export function ConfirmDialog({
  action,
  builtInRateBps,
  csrfToken,
  onClose,
  onChanged,
}: {
  readonly action: ConfirmAction;
  readonly builtInRateBps: number;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The list changed (or may have): the screen reads it again. */
  readonly onChanged: () => void;
}) {
  const t = useTranslations('tax');
  const errors = useTranslations('tax.error');
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const scope =
    action.kind === 'activate'
      ? 'activate-dialog'
      : action.kind === 'delete'
        ? 'delete-dialog'
        : 'built-in-dialog';
  const name = action.kind === 'built-in' ? '' : action.strategy.name;
  const rate = percentOf(builtInRateBps);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    try {
      const result =
        action.kind === 'delete'
          ? await callApi(
              'DELETE',
              `${TAX_STRATEGIES_PATH}/${encodeURIComponent(action.strategy.id)}`,
              undefined,
              csrfToken,
            )
          : await callApi(
              'POST',
              TAX_ACTIVE_PATH,
              { strategyId: action.kind === 'activate' ? action.strategy.id : null },
              csrfToken,
            );
      if (result.ok) {
        onChanged();
        onClose();
        toast.success(t(`${scope}.done`, { name }));
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      if (result.failure.code === 'tax.strategy-not-found') {
        onChanged();
        onClose();
        toast.error(errors('not-found'));
        return;
      }
      setProblem(errors(taxProblemOf(result.failure)));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      title={t(`${scope}.title`, { name })}
      onClose={() => {
        if (!pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" className="min-h-12" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button
            variant={action.kind === 'delete' ? 'destructive-solid' : 'primary'}
            className="min-h-12"
            loading={pending}
            onClick={() => void confirm()}
          >
            {t(`${scope}.confirm`)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg">{t(`${scope}.body`, { rate })}</p>
        {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
      </div>
    </Dialog>
  );
}
