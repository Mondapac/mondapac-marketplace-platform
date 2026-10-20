'use client';

import { Banner, Button, Dialog, LinkButton, OtpField, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { callApi, type ApiResult } from '../api/client.ts';

/** `callApi`, with the two-step code asked for and the request repeated when a rule needs one. */
export type GuardedCall = <T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  csrfToken?: string,
) => Promise<ApiResult<T>>;

/** The answer when the member closed the code dialog: the screen stays as it was, no message. */
export const STEP_UP_CANCELLED = 'step-up.cancelled';

const CANCELLED = { ok: false, failure: { status: 0, code: STEP_UP_CANCELLED } } as const;

export function isStepUpCancelled(result: ApiResult<unknown>): boolean {
  return !result.ok && result.failure.code === STEP_UP_CANCELLED;
}

/** Where a member sets up two-step verification. */
const SECURITY_PATH = '/account/security';

// Outside the provider (a page without the shell, a test of one screen) the call goes as it is.
const StepUpContext = createContext<GuardedCall>(callApi);

export const useGuardedCall = () => useContext(StepUpContext);

interface Ask {
  readonly actionKey: string;
  readonly mode: 'code' | 'enrol';
  readonly csrfToken: string;
  readonly settle: (verified: boolean) => void;
}

/**
 * The shared step-up code dialog of the seller panel (seller operations P-B). An action that the
 * shop's two-step rules guard answers `403 second-factor.required` with `details.actionKey`; the
 * dialog asks for a code, `POST identity/seller/step-up/verify` records the proof for that one
 * action, and the request is repeated once. Its answer, good or bad, goes back to the screen,
 * which shows it as it would any other. `second-factor.enrolment-required` sends the member to
 * Security instead. The server decides every time; the panel only follows the answer.
 */
export function StepUpProvider({ children }: { readonly children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  // A ref, not only state: two guarded answers before a render must not open two dialogs.
  const open = useRef(false);

  const guarded = useCallback<GuardedCall>(async (method, path, body, csrfToken) => {
    const first = await callApi<never>(method, path, body, csrfToken);
    if (first.ok) return first;
    const { code, details } = first.failure;
    const actionKey = details?.actionKey;
    if (
      (code !== 'second-factor.required' && code !== 'second-factor.enrolment-required') ||
      actionKey === undefined ||
      csrfToken === undefined
    )
      return first;
    if (open.current) return CANCELLED;
    open.current = true;
    const verified = await new Promise<boolean>((settle) =>
      setAsk({
        actionKey,
        mode: code === 'second-factor.required' ? 'code' : 'enrol',
        csrfToken,
        settle,
      }),
    );
    open.current = false;
    setAsk(null);
    if (!verified) return CANCELLED;
    return callApi(method, path, body, csrfToken);
  }, []);

  return (
    <StepUpContext.Provider value={guarded}>
      {children}
      {ask === null ? null : <StepUpDialog key={ask.actionKey} ask={ask} />}
    </StepUpContext.Provider>
  );
}

/** The words of the wait, as minutes and seconds (or hours) left. */
function waitText(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function StepUpDialog({ ask }: { readonly ask: Ask }) {
  const t = useTranslations('step-up');
  const [mode, setMode] = useState(ask.mode);
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  // A new key remounts the code field: the boxes clear and the first one takes focus again.
  const [fieldKey, setFieldKey] = useState(0);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const inFlight = useRef(false);
  const action = t.has(`action.${ask.actionKey}`)
    ? t(`action.${ask.actionKey}`)
    : t('action.fallback');

  useEffect(() => {
    if (waitUntil === null) return undefined;
    const tick = () => {
      const left = Math.ceil((waitUntil - Date.now()) / 1000);
      if (left > 0) setSecondsLeft(left);
      else {
        setWaitUntil(null);
        setProblem(null);
        setFieldKey((key) => key + 1);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [waitUntil]);

  const waiting = waitUntil !== null;

  function clearField() {
    setCode('');
    setFieldKey((key) => key + 1);
  }

  async function verify(typed: string) {
    // A code pasted from the app may carry spaces; a backup code may carry spaces or hyphens.
    const clean = typed.replace(/[\s-]/g, '');
    if (inFlight.current || waiting) return;
    if (clean === '') {
      setProblem(t('error.required'));
      return;
    }
    inFlight.current = true;
    setChecking(true);
    setProblem(null);
    const result = await callApi(
      'POST',
      'identity/seller/step-up/verify',
      { actionKey: ask.actionKey, code: clean },
      ask.csrfToken,
    );
    inFlight.current = false;
    setChecking(false);
    if (result.ok) {
      ask.settle(true);
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (failure.code === 'second-factor.invalid' || failure.code === 'validation.failed') {
      setProblem(t('error.invalid'));
      clearField();
      return;
    }
    if (failure.code === 'second-factor.locked' || failure.code === 'request.throttled') {
      const seconds = failure.details?.retryAfterSeconds ?? 60;
      clearField();
      // Both at once: the first paint already shows the whole wait, not 0:00.
      setSecondsLeft(seconds);
      setWaitUntil(Date.now() + seconds * 1000);
      return;
    }
    if (
      failure.code === 'second-factor.unavailable' ||
      failure.code === 'second-factor.enrolment-required'
    ) {
      setMode('enrol');
      return;
    }
    setProblem(t(failure.code === 'network' ? 'error.network' : 'error.unknown'));
  }

  function close() {
    if (!checking) ask.settle(false);
  }

  if (mode === 'enrol') {
    return (
      <Dialog
        open
        title={t('enrol.title')}
        onClose={close}
        actions={
          <>
            <Button variant="secondary" onClick={close}>
              {t('cancel')}
            </Button>
            <LinkButton href={SECURITY_PATH}>{t('enrol.action')}</LinkButton>
          </>
        }
      >
        <p>{t('enrol.body', { action })}</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={t(backup ? 'title-backup' : 'title')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" onClick={close} disabled={checking}>
            {t('cancel')}
          </Button>
          <Button loading={checking} disabled={waiting} onClick={() => void verify(code)}>
            {t(checking ? 'checking' : 'verify')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void verify(code);
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        <p>{t(backup ? 'body-backup' : 'body', { action })}</p>
        {backup ? (
          <TextField
            key={`backup-${fieldKey}`}
            label={t('label.backup-code')}
            name="code"
            autoComplete="one-time-code"
            autoFocus
            dir="ltr"
            value={code}
            readOnly={checking || waiting}
            onChange={(event) => setCode(event.target.value)}
            error={problem ?? undefined}
          />
        ) : (
          <OtpField
            key={`app-${fieldKey}`}
            label={t('label.code')}
            digitLabel={(position, total) => t('label.digit', { position, total })}
            name="code"
            autoFocus
            readOnly={checking || waiting}
            onChange={setCode}
            onComplete={(full) => void verify(full)}
            error={problem ?? undefined}
          />
        )}
        {waiting ? (
          <Banner tone="attention">{t('error.throttled', { wait: waitText(secondsLeft) })}</Banner>
        ) : null}
        <button
          type="button"
          className="inline-flex min-h-12 items-center self-start text-sm text-link hover:underline"
          disabled={checking}
          onClick={() => {
            setBackup(!backup);
            setProblem(null);
            clearField();
          }}
        >
          {t(backup ? 'use-app' : 'use-backup')}
        </button>
      </form>
    </Dialog>
  );
}
