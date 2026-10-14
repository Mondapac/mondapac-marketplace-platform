'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { ApiFailure } from '../api/client.ts';

/** The words for a refusal: a team reason, a generic error, the wait of a throttled answer. */
export function useFailureMessage(): (failure: ApiFailure | string) => string {
  const t = useTranslations('identity.team');
  const te = useTranslations('identity');
  return (input) => {
    const code = typeof input === 'string' ? input : input.code;
    if (code === 'request.throttled') {
      const seconds = typeof input === 'string' ? undefined : input.details?.retryAfterSeconds;
      return t('reason.request.throttled', {
        minutes: Math.max(1, Math.ceil((seconds ?? 60) / 60)),
      });
    }
    if (t.has(`reason.${code}`)) return t(`reason.${code}`);
    if (te.has(`error.${code}`)) return te(`error.${code}`);
    return te('error.unknown');
  };
}

/** One submit at a time, even when the button is pressed twice before a render. */
export function useSingleFlight() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  return {
    pending,
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setPending(true);
      try {
        return await task();
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
  };
}
