'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from '../account/use-dialog.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import {
  MESSAGE_LIMIT,
  QUICK_PROMPTS,
  newConversationId,
  pagePath,
  searchPath,
  sendMessage,
  visitorId,
  type AssistantReply,
  type AssistantSetup,
  type SendResult,
} from './assistant.ts';

/** After this long without an answer the widget says it is slow (the server gives up at 25 s). */
export const SLOW_AFTER_MS = 8000;

type Entry =
  | { readonly id: number; readonly role: 'user'; readonly text: string }
  | { readonly id: number; readonly role: 'assistant'; readonly kind: 'welcome' }
  | {
      readonly id: number;
      readonly role: 'assistant';
      readonly kind: 'reply';
      readonly reply: AssistantReply;
      readonly query: string;
      /** The support card follows: the server sent one, or the buyer missed twice. */
      readonly support: boolean;
    }
  | {
      readonly id: number;
      readonly role: 'assistant';
      readonly kind: 'error';
      readonly retry: string;
    }
  | { readonly id: number; readonly role: 'assistant'; readonly kind: 'stopped' }
  | { readonly id: number; readonly role: 'assistant'; readonly kind: 'support' };

type Status = 'chat' | 'off' | 'unavailable' | 'sign-in';

let nextId = 1;
const welcome = (): Entry => ({ id: nextId++, role: 'assistant', kind: 'welcome' });

/** Matches the sheet breakpoint of the CSS: 700px and under is a full-screen modal sheet. */
function useSheet(): boolean {
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 700px)');
    const update = () => setSheet(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return sheet;
}

/**
 * Keeps the launcher above the bottom dock (tab bar, cookie bar) and, at the end of the page, above
 * the footer's back-to-top button, so it never covers either. Writes `--as-dock` and `--as-lift`.
 */
function useLift(root: HTMLElement | null) {
  useEffect(() => {
    if (!root) return;
    const place = () => {
      const height = window.innerHeight;
      let dock = 0;
      const bar = document.querySelector('.dock');
      if (bar) {
        const rect = bar.getBoundingClientRect();
        if (rect.height > 0 && rect.top < height) dock = height - rect.top;
      }
      let lift = Math.max(20, dock + 12);
      const top = document.querySelector('.fbase .btt');
      if (top) {
        const rect = top.getBoundingClientRect();
        if (rect.height > 0 && rect.top < height - dock && rect.bottom > 0) {
          lift = Math.max(lift, height - rect.top + 12);
        }
      }
      root.style.setProperty('--as-dock', `${dock}px`);
      root.style.setProperty('--as-lift', `${lift}px`);
    };
    place();
    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    const bar = document.querySelector('.dock');
    if (bar) observer?.observe(bar);
    return () => {
      window.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [root]);
}

/**
 * The buyer assistant (package 5): a round launcher at the bottom right and the chat panel it
 * opens, docked (non-modal) over 700px and a full-screen modal sheet at 700px and under. Rendered
 * only when the storefront says the assistant is on for this visitor; with no setup nothing shows.
 * Model sentences are shown as plain text; products are a list of links built from server cards,
 * without prices (open point: prices in the list, default none).
 */
export function AssistantWidget({
  setup,
  send = sendMessage,
}: {
  readonly setup: AssistantSetup;
  /** The conversation call; tests pass a stub. */
  readonly send?: typeof sendMessage;
}) {
  const t = useTranslations('assistant');
  const router = useRouter();
  const path = usePathname();
  const { customer, setLoginOpen } = useStore();
  const sheet = useSheet();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(false);
  const [status, setStatus] = useState<Status>('chat');
  const [entries, setEntries] = useState<readonly Entry[]>(() => [welcome()]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [banner, setBanner] = useState<'limit' | 'full' | null>(null);
  const [rating, setRating] = useState<{ id: number; value: 'up' | 'down' } | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const conversation = useRef(newConversationId());
  const misses = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const visitor = useRef<string | null>(null);
  const limitWait = useRef(60);

  useEffect(() => {
    setMounted(true);
    let storage: Storage | null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    visitor.current = visitorId(storage);
    return () => abort.current?.abort();
  }, []);
  useLift(root);

  const close = useCallback(() => setOpen(false), []);
  const gated = status === 'sign-in' || (!setup.guestsAllowed && customer === null);
  const view: Status = gated ? 'sign-in' : status;

  // The sheet is a modal: focus starts on Close, Tab stays inside, Esc closes, focus returns.
  useDialog(open && sheet, close, panel, (el) => el.querySelector<HTMLElement>('[data-as=close]'));
  // The docked panel is not modal: focus starts in the message box, Esc closes, focus returns.
  useEffect(() => {
    if (!open || sheet) return;
    const el = panel.current;
    (
      el?.querySelector<HTMLElement>('textarea:not([disabled])') ??
      el?.querySelector<HTMLElement>('[data-as=close]')
    )?.focus({ preventScroll: true });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (launcher.current?.isConnected) launcher.current.focus({ preventScroll: true });
    };
  }, [open, sheet]);
  // A new page closes the full-screen sheet, which would otherwise cover it.
  useEffect(() => {
    if (sheet) setOpen(false);
    // Only a change of page closes it.
  }, [path]);
  // The newest message stays in view.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, busy, slow, open]);
  // The limit banner clears itself once the server's wait is over.
  useEffect(() => {
    if (banner !== 'limit') return;
    const timer = window.setTimeout(() => setBanner(null), limitWait.current * 1000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const push = (entry: Entry) => setEntries((list) => [...list, entry]);

  const settle = (result: SendResult, message: string) => {
    if (result.ok) {
      const missed = result.reply.notices.includes('unavailable');
      misses.current = missed ? misses.current + 1 : 0;
      const support = result.reply.support || misses.current >= 2;
      if (support) misses.current = 0;
      push({
        id: nextId++,
        role: 'assistant',
        kind: 'reply',
        reply: result.reply,
        query: message,
        support,
      });
      return;
    }
    const { refusal } = result;
    switch (refusal.kind) {
      case 'off':
        setStatus('off');
        return;
      case 'unavailable':
        setStatus('unavailable');
        return;
      case 'sign-in':
        setStatus('sign-in');
        return;
      case 'limit':
        limitWait.current = refusal.retryAfterSeconds;
        setBanner('limit');
        return;
      case 'full':
        setBanner('full');
        return;
      case 'lost':
        conversation.current = newConversationId();
        break;
      case 'error':
        break;
    }
    misses.current += 1;
    push({ id: nextId++, role: 'assistant', kind: 'error', retry: message });
    if (misses.current >= 2) {
      misses.current = 0;
      push({ id: nextId++, role: 'assistant', kind: 'support' });
    }
  };

  const ask = async (raw: string, echo = true) => {
    const message = raw.trim().slice(0, MESSAGE_LIMIT);
    if (message === '' || busy || banner !== null || view !== 'chat') return;
    if (echo) push({ id: nextId++, role: 'user', text: message });
    setDraft('');
    setRating(null);
    setBusy(true);
    setSlow(false);
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    let result: SendResult;
    try {
      result = await send(setup, conversation.current, message, visitor.current, controller.signal);
    } catch {
      result = { ok: false, refusal: { kind: 'error' } };
    }
    window.clearTimeout(timer);
    abort.current = null;
    setBusy(false);
    setSlow(false);
    if (controller.signal.aborted) {
      push({ id: nextId++, role: 'assistant', kind: 'stopped' });
      return;
    }
    settle(result, message);
  };

  const stop = () => abort.current?.abort();

  const restart = () => {
    abort.current?.abort();
    conversation.current = newConversationId();
    misses.current = 0;
    setEntries([welcome()]);
    setRating(null);
    setDraft('');
    if (banner === 'full') setBanner(null);
    box.current?.focus();
  };

  const retry = (entry: Extract<Entry, { kind: 'error' }>) => {
    setEntries((list) => list.filter((item) => item.id !== entry.id));
    void ask(entry.retry, false);
  };

  const go = (href: string) => {
    if (sheet) setOpen(false);
    router.push(href);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(draft);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(draft);
    }
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const lastReply = [...entries]
    .reverse()
    .find((entry) => entry.role === 'assistant' && entry.kind === 'reply');
  const signedIn = customer !== null;
  const days = setup.retentionDays === null ? 'unknown' : String(setup.retentionDays);
  const mail = `mailto:${setup.supportEmail}`;

  const supportCard = (
    <div className="ascard">
      <div className="cap">
        <Icon name="mail" />
        {t('support-title')}
      </div>
      <div className="bd">
        <div className="asnote">{t('support-text')}</div>
        <div className="asact">
          <a className="btn small" href={mail}>
            {t('support-email')}
          </a>
        </div>
      </div>
    </div>
  );

  const chips = (keys: readonly string[], label: string) => (
    <div className="asqp" role="group" aria-label={label}>
      {keys.map((key) => (
        <button className="aschip" type="button" key={key} onClick={() => void ask(t(key))}>
          {t(key)}
        </button>
      ))}
    </div>
  );

  const replyBody = (entry: Extract<Entry, { kind: 'reply' }>) => {
    const { reply } = entry;
    const said = reply.sentences.join(' ');
    const nothing =
      said === '' &&
      reply.products.length === 0 &&
      reply.pages.length === 0 &&
      reply.notices.length === 0 &&
      !entry.support;
    if (nothing) {
      return (
        <>
          <div className="asb">{t('empty')}</div>
          {chips(['empty-halal', 'empty-categories', 'empty-offers'], t('empty-label'))}
        </>
      );
    }
    const pages = reply.pages
      .map((card) => ({ card, href: pagePath(card) }))
      .filter((page): page is { card: typeof page.card; href: string } => page.href !== null);
    return (
      <>
        {said !== '' || reply.products.length > 0 ? (
          <div className="asb">
            {said !== '' ? said : t('found')}
            {reply.products.length > 0 ? (
              <ul className="aslist">
                {reply.products.map((card) => (
                  <li key={card.offerId}>
                    <Link
                      href={`/p/${encodeURIComponent(card.productId)}`}
                      onClick={() => sheet && setOpen(false)}
                    >
                      {card.name}
                    </Link>
                    {card.shortText ? <small>{card.shortText}</small> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {reply.products.length > 0 || pages.length > 0 ? (
          <div className="aslinks">
            {reply.products.length > 0 ? (
              <button className="aslk" type="button" onClick={() => go(searchPath(entry.query))}>
                {t('see-all')}
                <Icon name="chevr" />
              </button>
            ) : null}
            {pages.map(({ card, href }) => (
              <button
                className="aslk"
                type="button"
                key={`${card.page}:${href}`}
                onClick={() => go(href)}
              >
                {t(`page-${card.page}`)}
                <Icon name="chevr" />
              </button>
            ))}
          </div>
        ) : null}
        {reply.products.length > 0 ? <div className="asnote">{t('product-note')}</div> : null}
        {reply.notices.map((code) => (
          <div className="asnote" key={code}>
            {t(`notice-${code}`)}
          </div>
        ))}
        {reply.notices.includes('unavailable') ? (
          <div className="aslinks">
            <button className="aslk" type="button" onClick={() => go(searchPath(entry.query))}>
              {t('search-site')}
              <Icon name="chevr" />
            </button>
          </div>
        ) : null}
        {entry.support ? supportCard : null}
      </>
    );
  };

  const message = (entry: Entry) => {
    if (entry.role === 'user') {
      return (
        <div className="asm u" key={entry.id}>
          <span className="asvh">{t('you-said')}</span>
          <div className="asb">{entry.text}</div>
        </div>
      );
    }
    const isLast = lastReply?.id === entry.id && !busy;
    return (
      <div className="asm a" key={entry.id}>
        <span className="asvh">{t('assistant-said')}</span>
        {entry.kind === 'welcome' ? (
          <>
            <div className="asb">{setup.welcomeText ?? t('welcome')}</div>
            {chips(QUICK_PROMPTS, t('quick-label'))}
          </>
        ) : null}
        {entry.kind === 'reply' ? replyBody(entry) : null}
        {entry.kind === 'stopped' ? <div className="asb">{t('stopped')}</div> : null}
        {entry.kind === 'support' ? (
          <>
            <div className="asb">{t('support-intro')}</div>
            {supportCard}
          </>
        ) : null}
        {entry.kind === 'error' ? (
          <>
            <div className="asb err" role="alert">
              <Icon name="warn" />
              <span>{t('error')}</span>
            </div>
            <div className="asact">
              <button className="btn small" type="button" onClick={() => retry(entry)}>
                {t('retry')}
              </button>
              <button
                className="btn small ghost"
                type="button"
                onClick={() => go(searchPath(entry.retry))}
              >
                {t('search-site')}
              </button>
            </div>
          </>
        ) : null}
        {isLast ? (
          <>
            <div className="asfb" role="group" aria-label={t('rate')}>
              <button
                type="button"
                aria-label={t('good')}
                aria-pressed={rating?.id === entry.id && rating.value === 'up'}
                onClick={() => setRating({ id: entry.id, value: 'up' })}
              >
                <Icon name="thumb-up" />
              </button>
              <button
                type="button"
                aria-label={t('bad')}
                aria-pressed={rating?.id === entry.id && rating.value === 'down'}
                onClick={() => setRating({ id: entry.id, value: 'down' })}
              >
                <Icon name="thumb-down" />
              </button>
            </div>
            {rating?.id === entry.id && rating.value === 'down' ? (
              <>
                <div className="asnote" role="status">
                  {t('sorry')}
                </div>
                {entry.kind === 'reply' && entry.support ? null : supportCard}
              </>
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  const stateView = (kind: Exclude<Status, 'chat'>) => {
    if (kind === 'sign-in') {
      return (
        <div className="asstate">
          <span className="big" aria-hidden="true">
            <Icon name="user" />
          </span>
          <h3>{t('sign-in-title')}</h3>
          <p>{t('sign-in-text')}</p>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setOpen(false);
              setLoginOpen(true);
            }}
          >
            {t('sign-in')}
          </button>
        </div>
      );
    }
    return (
      <div className="asstate">
        <span className="big" aria-hidden="true">
          <Icon name={kind === 'off' ? 'spark' : 'warn'} />
        </span>
        <h3>{t(`${kind}-title`)}</h3>
        <p>{t(`${kind}-text`)}</p>
        <form
          className="assf"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const field = new FormData(event.currentTarget).get('q');
            go(typeof field === 'string' && field.trim() !== '' ? searchPath(field) : '/search');
          }}
        >
          <input
            type="search"
            name="q"
            aria-label={t('search-label')}
            placeholder={t('search-label')}
          />
          <button className="btn" type="submit" aria-label={t('search')}>
            <Icon name="search" />
          </button>
        </form>
        <a className="aslk" href={mail}>
          {t('talk-support')}
        </a>
      </div>
    );
  };

  if (!mounted) return null;
  return createPortal(
    <div className="asw" ref={setRoot} data-open={open} data-sheet={sheet}>
      <button
        className="aslaunch"
        type="button"
        ref={launcher}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="aspanel"
        aria-label={t('launch')}
        onClick={() => setOpen(true)}
      >
        <Icon name="spark" />
      </button>
      <section
        className="aspanel"
        id="aspanel"
        ref={panel}
        role="dialog"
        aria-modal={sheet}
        aria-labelledby="as-title"
        hidden={!open}
      >
        <div className="ash">
          <span className="asav" aria-hidden="true">
            <Icon name="spark" />
          </span>
          <div className="ashm">
            <h2 id="as-title">{t('title')}</h2>
            <button
              className="asai"
              type="button"
              aria-expanded={info}
              aria-controls="as-info"
              onClick={() => setInfo((shown) => !shown)}
            >
              <Icon name="info" />
              {t('ai-pill')}
            </button>
          </div>
          {view === 'chat' ? (
            <button
              className="asx"
              type="button"
              aria-label={t('new-chat')}
              title={t('new-chat-short')}
              onClick={restart}
            >
              <Icon name="pen" />
            </button>
          ) : null}
          <button
            className="asx"
            type="button"
            data-as="close"
            aria-label={t('close')}
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="asinfo" id="as-info" hidden={!info}>
          <b>{t('info-title')}</b>
          <span>{t('info-mistakes')}</span>
          <ul>
            <li>{t('info-can')}</li>
            <li>{t('info-cannot')}</li>
          </ul>
          <span>
            {t('info-private')}{' '}
            {signedIn ? t('info-kept-account', { days }) : t('info-kept-guest', { days })}
          </span>
        </div>
        {view === 'chat' ? (
          <>
            <div
              className="aslog"
              ref={log}
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label={t('log')}
              tabIndex={-1}
            >
              {entries.map(message)}
              {busy ? (
                <div className="asm a">
                  <div className="asb" role="status" aria-label={t('typing')}>
                    <span className="asdots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  {slow ? (
                    <div className="asnote" role="status">
                      {t('slow')}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {banner !== null ? (
              <div className="asbn" role="status">
                <Icon name="info" />
                <span>{t(banner)}</span>
              </div>
            ) : null}
            <form className="ascomp" onSubmit={submit}>
              <label className="asvh" htmlFor="as-input">
                {t('message-label')}
              </label>
              <textarea
                id="as-input"
                ref={box}
                rows={1}
                maxLength={MESSAGE_LIMIT}
                placeholder={t('placeholder')}
                value={draft}
                disabled={banner !== null}
                onChange={(event) => {
                  setDraft(event.target.value);
                  grow(event.target);
                }}
                onKeyDown={onKey}
              />
              {busy ? (
                <button className="assend" type="button" aria-label={t('stop')} onClick={stop}>
                  <Icon name="stop" />
                </button>
              ) : (
                <button
                  className="assend"
                  type="submit"
                  aria-label={t('send')}
                  disabled={draft.trim() === '' || banner !== null}
                >
                  <Icon name="send" />
                </button>
              )}
            </form>
            <div className="asfoot">
              <span className="asnote">{t('foot')}</span>
              <button
                className="aslk"
                type="button"
                onClick={() => push({ id: nextId++, role: 'assistant', kind: 'support' })}
              >
                {t('talk-support')}
              </button>
            </div>
          </>
        ) : (
          stateView(view)
        )}
      </section>
    </div>,
    document.body,
  );
}
