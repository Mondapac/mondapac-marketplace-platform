'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../icons/icon.tsx';

/**
 * The product description, justified and clamped to three lines; when it does not fit, the
 * third line fades and "Show more" appears.
 */
export function Description({ text }: { readonly text: string }) {
  const t = useTranslations('product');
  const id = useId();
  const box = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element || expanded) return;
    const check = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    check();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    void document.fonts?.ready.then(check);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <>
      <p
        className={expanded ? 'desc' : overflows ? 'desc clamp fade' : 'desc clamp'}
        id={id}
        ref={box}
      >
        {text}
      </p>
      {overflows || expanded ? (
        <button
          className="dmore"
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t('show-less') : t('show-more')}
          <Icon name="chevr" />
        </button>
      ) : null}
    </>
  );
}
