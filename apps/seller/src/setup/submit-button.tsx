'use client';

import { Banner, Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { SETUP_ROOT } from './steps.ts';
import { messageKeyOf, REFRESH_CODES } from './submit-errors.ts';

/** The one submit action of S6. Any refusal leaves the page where it is, with the reason. */
export function SubmitButton({
  csrfToken,
  disabled,
  again,
}: {
  readonly csrfToken: string;
  readonly disabled: boolean;
  readonly again: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);

  async function submit() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi('POST', 'sellers/my-file/submit', {}, csrfToken);
    if (result.ok) {
      // Stay busy until the page changes, so a quick second click sends nothing.
      router.push(SETUP_ROOT);
      router.refresh();
      return;
    }
    busy.current = false;
    setPending(false);
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (!REFRESH_CODES.has(failure.code)) setProblem(messageKeyOf(failure));
    if (
      REFRESH_CODES.has(failure.code) ||
      failure.code === 'file.incomplete' ||
      failure.code === 'slug.taken'
    ) {
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {problem === null ? null : <Banner tone="critical">{t(problem)}</Banner>}
      <div>
        <Button loading={pending} disabled={disabled} onClick={() => void submit()}>
          {t(again ? 'sellers.submit.action.again' : 'sellers.submit.action.submit')}
        </Button>
      </div>
    </div>
  );
}
