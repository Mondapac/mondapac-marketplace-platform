'use client';

import { useId, useState, type ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';
import { under } from '../shell/breakpoints.ts';
import { useEffect } from 'react';

type Mode = 'server' | 'phone' | 'wide';

/**
 * A product page section that is a collapsible on a phone (under 700px) and a plain heading with
 * its content everywhere else. On the phone the heading holds a 44px button (`aria-expanded`,
 * `aria-controls`) and the content starts closed. Until the browser has measured the screen the
 * content follows the CSS (closed on a phone), so nothing jumps.
 */
export function Collapsible({
  title,
  level,
  open: startOpen = false,
  children,
}: {
  readonly title: string;
  readonly level: 'h2' | 'h3';
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  const id = useId();
  const [mode, setMode] = useState<Mode>('server');
  const [open, setOpen] = useState(startOpen);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      setMode('wide');
      return;
    }
    const query = window.matchMedia(under('tablet'));
    const update = () => setMode(query.matches ? 'phone' : 'wide');
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const Heading = level;
  const phone = mode === 'phone';
  return (
    <div className="acc" data-mode={mode} data-open={phone ? String(open) : undefined}>
      <Heading>
        {phone ? (
          <button
            type="button"
            className="acc-btn"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
          >
            {title}
            <Icon name="chevr" />
          </button>
        ) : (
          title
        )}
      </Heading>
      <div className="acc-panel" id={id} hidden={phone && !open}>
        {children}
      </div>
    </div>
  );
}
