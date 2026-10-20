'use client';

import { useRef } from 'react';
import { Icon } from '../icons/icon.tsx';

/**
 * The sell page's questions: native details elements sharing one `name`, so a browser keeps one
 * open at a time (john). Browsers without exclusive details get the same from the toggle handler.
 */
export function SellFaq({
  items,
}: {
  readonly items: readonly { readonly question: string; readonly answer: string }[];
}) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div className="sg-faq" ref={box}>
      {items.map((item) => (
        <details
          key={item.question}
          name="sgfaq"
          onToggle={(event) => {
            const opened = event.currentTarget;
            if (!opened.open) return;
            for (const other of box.current?.querySelectorAll('details') ?? []) {
              if (other !== opened) other.open = false;
            }
          }}
        >
          <summary>
            {item.question}
            <Icon name="chevd" />
          </summary>
          <p>{item.answer}</p>
        </details>
      ))}
    </div>
  );
}
