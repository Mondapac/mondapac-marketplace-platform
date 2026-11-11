'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon } from '../icons/icon.tsx';
import { markParts } from './suggest-marks.ts';
import { SUGGEST_PATH, type SuggestAnswer } from './suggest-types.ts';

// The typeahead of the header search box and of the phone and tablet search view (search package
// 1b, approved in search-suggestions). It starts at 2 characters, waits 120 ms after the last
// key, drops the request a newer one replaces, and never stands in the way of a search: Enter
// with no row chosen submits the form as before, and a failed or slow read changes nothing else.
// The pattern is the ARIA combobox with a listbox popup (input keeps focus, rows are options).

export const SUGGEST_MIN = 2;
export const SUGGEST_DEBOUNCE_MS = 120;

type Result =
  | { readonly q: string; readonly answer: SuggestAnswer }
  | { readonly q: string; readonly failed: true };

/** One row of the listbox, in reading order: products, stores, then "See all results". */
type Row =
  | { readonly kind: 'product'; readonly index: number }
  | { readonly kind: 'store'; readonly index: number }
  | { readonly kind: 'all' };

const isAnswer = (body: unknown): body is SuggestAnswer =>
  typeof body === 'object' &&
  body !== null &&
  Array.isArray((body as SuggestAnswer).products) &&
  Array.isArray((body as SuggestAnswer).stores) &&
  typeof (body as SuggestAnswer).total === 'number';

export interface SuggestBoxOptions {
  /** The words the box starts with (the results page keeps what was searched for). */
  readonly initial?: string;
  /** The panel is part of the page (the phone search view) and not a popup under the box. */
  readonly inline?: boolean;
  /** A row was chosen: the search view closes. */
  readonly onPick?: () => void;
}

export function useSuggestBox({ initial = '', inline = false, onPick }: SuggestBoxOptions = {}) {
  const t = useTranslations('suggest');
  const router = useRouter();
  const base = useId();
  const listId = `${base}-list`;
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [slow, setSlow] = useState(false);
  const [active, setActive] = useState(-1);
  // Esc closed the list: it stays closed (on a phone too) until the next change of the words.
  const [dismissed, setDismissed] = useState(false);
  const q = text.trim().replace(/\s+/gu, ' ');
  const idle = Array.from(q).length < SUGGEST_MIN;

  useEffect(() => {
    if (idle) return;
    const controller = new AbortController();
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const start = setTimeout(() => {
      // Skeleton rows only when the answer takes longer than the debounce itself.
      slowTimer = setTimeout(() => setSlow(true), SUGGEST_DEBOUNCE_MS);
      const settle = (next: Result) => {
        // A read that a newer one replaced may still answer (it ignored the abort): drop it.
        if (controller.signal.aborted) return;
        clearTimeout(slowTimer);
        setSlow(false);
        setResult(next);
        setActive(-1);
      };
      fetch(`${SUGGEST_PATH}?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then(async (response) => {
          const body: unknown = response.ok ? await response.json() : null;
          settle(isAnswer(body) ? { q, answer: body } : { q, failed: true });
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          settle({ q, failed: true });
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(slowTimer);
      controller.abort();
      setSlow(false);
    };
  }, [q, idle]);

  // Only the answer to the words now in the box counts: for the rows, the skeleton and the keys.
  const current = result !== null && result.q === q && !idle ? result : null;
  const answer = current !== null && 'answer' in current ? current.answer : null;
  const rows: Row[] = [];
  if (answer !== null) {
    answer.products.forEach((_, index) => rows.push({ kind: 'product', index }));
    answer.stores.forEach((_, index) => rows.push({ kind: 'store', index }));
    rows.push({ kind: 'all' });
  }
  const failed = current !== null && 'failed' in current;
  // Under two characters nothing shows. A phone's view keeps its panel while the box is blurred.
  const visible = !idle && !dismissed && (inline || open) && (current !== null || slow);
  // An error leaves a note and no list to choose from.
  const expanded = visible && !failed;
  const optionId = (i: number) => `${base}-opt-${i}`;
  const activeRow = expanded && active >= 0 && active < rows.length ? active : -1;

  const submit = () => input.current?.form?.requestSubmit();
  const choose = (row: Row | undefined) => {
    if (row === undefined || answer === null) return;
    if (row.kind === 'all') return submit();
    const href =
      row.kind === 'product' ? answer.products[row.index]?.href : answer.stores[row.index]?.href;
    if (href === undefined) return;
    input.current?.blur();
    onPick?.();
    router.push(href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const move = (to: number) => {
      event.preventDefault();
      setOpen(true);
      setActive(to);
    };
    if (event.key === 'ArrowDown' && rows.length > 0) {
      setDismissed(false);
      move((activeRow + 1) % rows.length);
    } else if (event.key === 'ArrowUp' && rows.length > 0) {
      setDismissed(false);
      move(activeRow <= 0 ? rows.length - 1 : activeRow - 1);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && activeRow >= 0) {
      event.preventDefault();
      choose(rows[activeRow]);
    } else if (event.key === 'Escape') {
      // First Esc closes the list, the second clears the box; with both done Esc passes on
      // (the search view closes).
      if (visible) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setDismissed(true);
        setActive(-1);
      } else if (text !== '') {
        event.preventDefault();
        event.stopPropagation();
        setText('');
        setResult(null);
        setDismissed(false);
        setActive(-1);
      }
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const inputProps = {
    ref: input,
    value: text,
    role: 'combobox' as const,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': expanded,
    'aria-controls': listId,
    'aria-haspopup': 'listbox' as const,
    ...(activeRow >= 0 ? { 'aria-activedescendant': optionId(activeRow) } : {}),
    autoComplete: 'off',
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setText(event.target.value);
      if (Array.from(event.target.value.trim()).length < SUGGEST_MIN) setResult(null);
      setDismissed(false);
      setOpen(true);
      setActive(-1);
    },
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onKeyDown,
  };

  const live = !visible
    ? ''
    : failed
      ? t('error')
      : answer === null
        ? t('loading')
        : answer.products.length + answer.stores.length === 0
          ? t('none', { q })
          : t('found', { products: answer.products.length, stores: answer.stores.length });

  const panel = (
    <SuggestPanel
      id={listId}
      shown={visible}
      inline={inline}
      q={q}
      answer={answer}
      failed={failed}
      loading={slow && current === null}
      activeRow={activeRow}
      optionId={optionId}
      onChoose={(row) => {
        setOpen(false);
        if (row.kind === 'all') return submit();
        onPick?.();
      }}
      live={live}
    />
  );

  return { text, setText, inputProps, panel, replacing: inline && !idle && !dismissed };
}

interface PanelProps {
  readonly id: string;
  readonly shown: boolean;
  readonly inline: boolean;
  readonly q: string;
  readonly answer: SuggestAnswer | null;
  readonly failed: boolean;
  readonly loading: boolean;
  readonly activeRow: number;
  readonly optionId: (i: number) => string;
  readonly onChoose: (row: Row) => void;
  readonly live: string;
}

function Marked({ text, q }: { readonly text: string; readonly q: string }) {
  return (
    <>
      {markParts(text, q).map((part, i) =>
        part.marked ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

function SuggestPanel(props: PanelProps) {
  const t = useTranslations('suggest');
  const { answer, q, activeRow } = props;
  // Pressing a row must not take the focus from the box (it would close the list first).
  const keepFocus = {
    onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
  };
  const productCount = answer?.products.length ?? 0;
  const storeCount = answer?.stores.length ?? 0;
  const none = answer !== null && productCount + storeCount === 0;
  let rowNumber = 0;

  let note: ReactNode;
  let list: ReactNode;
  if (props.failed) {
    note = <p className="tanote">{t('error')}</p>;
  } else if (answer === null) {
    note = props.loading ? (
      <div className="tasq-set" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div className="tasq" key={i}>
            <i />
            <span>
              <i />
              <i />
            </span>
          </div>
        ))}
      </div>
    ) : null;
  } else {
    note = none ? <p className="tanote">{t('none', { q })}</p> : null;
    list = (
      <>
        {productCount > 0 ? (
          <div role="group" aria-labelledby={`${props.id}-p`}>
            <div className="tah" id={`${props.id}-p`}>
              {t('products')}
            </div>
            {answer.products.map((p) => {
              const i = rowNumber++;
              return (
                <Link
                  key={p.id}
                  id={props.optionId(i)}
                  role="option"
                  aria-selected={i === activeRow}
                  tabIndex={-1}
                  href={p.href}
                  className={`tarow${i === activeRow ? ' on' : ''}`}
                  onClick={() => props.onChoose({ kind: 'product', index: i })}
                  {...keepFocus}
                >
                  <span className="tath" aria-hidden="true">
                    {p.imageUrl === null ? (
                      <Icon name="box" />
                    ) : (
                      <img src={p.imageUrl} alt="" loading="lazy" decoding="async" />
                    )}
                  </span>
                  <span className="tat">
                    <b>
                      <Marked text={p.name} q={q} />
                    </b>
                    <small>
                      <Marked
                        text={
                          p.categoryName === null
                            ? p.sellerName
                            : `${p.sellerName} · ${p.categoryName}`
                        }
                        q={q}
                      />
                    </small>
                  </span>
                </Link>
              );
            })}
          </div>
        ) : null}
        {storeCount > 0 ? (
          <div role="group" aria-labelledby={`${props.id}-s`}>
            <div className="tah" id={`${props.id}-s`}>
              {t('stores')}
            </div>
            {answer.stores.map((s) => {
              const i = rowNumber++;
              return (
                <Link
                  key={s.slug}
                  id={props.optionId(i)}
                  role="option"
                  aria-selected={i === activeRow}
                  tabIndex={-1}
                  href={s.href}
                  className={`tarow${i === activeRow ? ' on' : ''}`}
                  onClick={() => props.onChoose({ kind: 'store', index: i })}
                  {...keepFocus}
                >
                  <span className="talg" aria-hidden="true">
                    {Array.from(s.name)[0]?.toUpperCase() ?? ''}
                  </span>
                  <span className="tat">
                    <b>
                      <Marked text={s.name} q={q} />
                    </b>
                    <small>{t('store-products', { count: s.productCount })}</small>
                  </span>
                </Link>
              );
            })}
          </div>
        ) : null}
        <Link
          id={props.optionId(rowNumber)}
          role="option"
          aria-selected={rowNumber === activeRow}
          tabIndex={-1}
          href={`/search?q=${encodeURIComponent(q)}`}
          className={`tarow taall${rowNumber === activeRow ? ' on' : ''}`}
          onClick={(event) => {
            // The form runs the search, so focus lands on the results heading as for Enter.
            event.preventDefault();
            props.onChoose({ kind: 'all' });
          }}
          {...keepFocus}
        >
          <Icon name="search" />
          <span className="tat">
            <b>
              {answer.total === 0
                ? t('see-all-none', { q })
                : t('see-all', { q, n: answer.total, capped: String(answer.totalIsCapped) })}
            </b>
          </span>
        </Link>
      </>
    );
  }

  return (
    <>
      <div className={`tapanel${props.inline ? ' in' : ''}`} hidden={!props.shown}>
        {props.shown ? note : null}
        <div id={props.id} role="listbox" aria-label={t('label')} hidden={!props.shown || !list}>
          {props.shown ? list : null}
        </div>
      </div>
      <div className="tasr" role="status" aria-live="polite">
        {props.live}
      </div>
    </>
  );
}
