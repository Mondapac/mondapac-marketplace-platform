'use client';

import { useTranslations } from 'next-intl';
import { splitInvisible } from './text-diff.ts';

/**
 * Text a seller wrote, shown to a reviewer: isolated from the text around it (`unicode-bidi:
 * isolate`, so a direction mark inside it cannot reorder what comes before or after) and with each
 * invisible character drawn as its code point, so a hidden character is seen and not trusted.
 */
export function SafeText({ text }: { readonly text: string }) {
  const t = useTranslations('offer-review.diff');
  return (
    <span className="[unicode-bidi:isolate]">
      {splitInvisible(text).map((run, index) =>
        run.hidden ? (
          <span
            key={index}
            aria-label={t('hidden-char', { code: run.text })}
            role="img"
            className="mx-0.5 rounded-sm border border-attention-border bg-attention-bg px-1 font-mono text-xs text-attention-fg [unicode-bidi:isolate]"
          >
            {run.text}
          </span>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </span>
  );
}
