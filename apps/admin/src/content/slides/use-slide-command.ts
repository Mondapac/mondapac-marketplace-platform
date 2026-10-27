'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import {
  findingsOf,
  isStale,
  messageOf,
  type CommandMessage,
  type Finding,
} from './slide-commands.ts';
import {
  commandPath,
  type SlideCommand,
  type SlideDetail,
  type SlidePlacement,
} from './slide-types.ts';

export interface CommandProblem {
  readonly message: CommandMessage;
  /** The slide changed meanwhile: the dialog says so and the page is read again on close. */
  readonly stale: boolean;
  readonly findings: readonly Finding[];
}

/**
 * Runs one command of a slide (a POST) at a time, even when a button is pressed twice before a
 * render, and keeps the refusal for the dialog to show. `placements` are those of the version the
 * command checks, so a refused position or scope can be named.
 */
export function useSlideCommand(csrfToken: string) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<CommandProblem | null>(null);

  const run = useCallback(
    async (
      slideId: string,
      command: SlideCommand,
      body: Record<string, unknown>,
      placements: readonly SlidePlacement[],
    ): Promise<SlideDetail | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setPending(true);
      setProblem(null);
      try {
        const result = await callApi<SlideDetail>(
          'POST',
          commandPath(slideId, command),
          body,
          csrfToken,
        );
        if (result.ok) return result.body;
        if (result.failure.status === 401) {
          router.replace('/session-ended');
          return null;
        }
        const message = messageOf(result.failure);
        setProblem({
          message,
          stale: isStale(message),
          findings: findingsOf(result.failure, placements),
        });
        return null;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [csrfToken, router],
  );

  const reset = useCallback(() => setProblem(null), []);
  return { pending, problem, run, reset };
}
