'use client';

import { useLocale } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { languageTag } from '../i18n/locale.ts';
import { useStore } from '../shell/store-context.tsx';
import { AssistantWidget } from './assistant-widget.tsx';
import {
  PREVIEW_HEADER,
  storefrontReadOf,
  visitorId,
  type AssistantBase,
  type AssistantSetup,
  type StorefrontRead,
} from './assistant.ts';
import { dropPreview, takePreview } from './preview.ts';

const session = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};
const local = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * Asks the API whether the assistant is on for this browser: `GET <chatUrl>/storefront` with this
 * browser's visitor id (a percentage rollout needs it) and the page language, plus the internal
 * preview token as a header when this tab holds one. Null on any failure.
 */
export async function readStorefront(
  chatUrl: string,
  visitor: string | null,
  lang: string,
  preview: string | null,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<StorefrontRead | null> {
  const query = new URLSearchParams();
  if (visitor !== null) query.set('visitor', visitor);
  query.set('lang', lang);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (preview !== null) headers[PREVIEW_HEADER] = preview;
  try {
    const response = await fetcher(`${chatUrl}/storefront?${query.toString()}`, {
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    return response.ok ? storefrontReadOf(await response.json()) : null;
  } catch {
    // Off, offline or aborted: the assistant simply does not show, with no noise.
    return null;
  }
}

/**
 * The buyer assistant's gate. The server render cannot know the visitor id, so the browser asks
 * the API and this renders nothing until it answers `enabled: true`. It also takes the internal
 * preview token from the URL fragment (preview.ts) before anything else can see it.
 */
export function AssistantGate({ base }: { readonly base: AssistantBase }) {
  const locale = useLocale();
  const { customer } = useStore();
  const { chatUrl } = base;
  const [answer, setAnswer] = useState<{
    readonly read: StorefrontRead;
    readonly preview: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const store = session();
    const token = takePreview(window.location, window.history, store);
    void readStorefront(
      chatUrl,
      visitorId(local()),
      languageTag(locale),
      token,
      controller.signal,
    ).then((read) => {
      if (controller.signal.aborted) return;
      // The server does not accept the token (expired, wrong environment): forget it.
      if (token !== null && read?.preview !== true) dropPreview(store);
      setAnswer(read?.enabled === true ? { read, preview: read.preview ? token : null } : null);
    });
    return () => controller.abort();
  }, [chatUrl, locale]);

  const signedIn = customer !== null;
  const setup = useMemo<AssistantSetup | null>(() => {
    if (answer === null) return null;
    const { read } = answer;
    return {
      ...base,
      guestsAllowed: read.guestsAllowed,
      welcomeText: read.welcomeText,
      retentionDays:
        read.retentionDays === null
          ? null
          : signedIn
            ? read.retentionDays.customer
            : read.retentionDays.guest,
      quickPrompts: read.quickPrompts,
      preview: read.preview,
    };
  }, [answer, base, signedIn]);

  if (setup === null || answer === null) return null;
  return <AssistantWidget setup={setup} previewToken={answer.preview} />;
}
