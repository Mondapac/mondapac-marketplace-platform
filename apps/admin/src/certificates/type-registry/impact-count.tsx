'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { API_IMPACT_COUNT, type ImpactCount } from './types.ts';

export type ImpactState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly count: ImpactCount }
  | { readonly kind: 'failed' };

/**
 * How many published texts the claim terms would match once the type is active
 * (catalog claim-terms.impact-count). A failed count never blocks the page or the send.
 */
export function useImpactCount(
  csrfToken: string,
  typeCode: string | undefined,
  termsByLocale: Readonly<Record<string, readonly string[]>>,
): ImpactState {
  const [state, setState] = useState<ImpactState>({ kind: 'loading' });
  const key = JSON.stringify([typeCode, termsByLocale]);
  useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    const body = {
      ...(typeCode === undefined ? {} : { typeCode }),
      termsByLocale: (JSON.parse(key) as [unknown, Record<string, string[]>])[1],
    };
    void callApi<ImpactCount>('POST', API_IMPACT_COUNT, body, csrfToken).then((result) => {
      if (!current) return;
      if (!result.ok && result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setState(result.ok ? { kind: 'ok', count: result.body } : { kind: 'failed' });
    });
    return () => {
      current = false;
    };
  }, [key, csrfToken, typeCode]);
  return state;
}

/** The count in words; `context` says whether the reader can still send the type. */
export function ImpactLine({
  state,
  context,
}: {
  readonly state: ImpactState;
  readonly context: 'send' | 'view';
}) {
  const t = useTranslations('certificates.types.impact');
  return (
    <p aria-live="polite" className="text-sm wrap-anywhere">
      {state.kind === 'loading'
        ? t('loading')
        : state.kind === 'failed'
          ? t(context === 'send' ? 'failed-send' : 'failed-view')
          : state.count.total === 0 && state.count.complete
            ? t('none')
            : t(state.count.complete ? 'count' : 'count-at-least', { total: state.count.total })}
    </p>
  );
}
