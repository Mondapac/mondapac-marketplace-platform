'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
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
import * as customerApi from '../account/customer-api.ts';
import { useDialog } from '../account/use-dialog.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { under } from '../shell/breakpoints.ts';
import { useStore } from '../shell/store-context.tsx';
import { productHref } from '../storefront/links.ts';
import {
  MESSAGE_LIMIT,
  QUICK_PROMPTS,
  deleteConversation,
  listConversations,
  newConversationId,
  pagePath,
  readConversation,
  searchPath,
  sendFeedback,
  sendMessage,
  visitorId,
  type AssistantReply,
  type ConversationSummary,
  type CardMoney,
  type AssistantSetup,
  type FeedbackReason,
  type SendResult,
  type StoredConversation,
} from './assistant.ts';
import {
  BasketProposalCardView,
  CartActionCardView,
  CartSummaryCardView,
} from './cart-card-views.tsx';
import { dockForLauncher, launcherHidden, launcherLift, movingBarBox } from './launcher-lift.ts';

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
      /** The conversation this answer belongs to (the id in force when it arrived). */
      readonly conversationId: string;
      /** The answer's position in its conversation (2 for the first), null when it is not known. */
      readonly position: number | null;
      /** Read back from history: the text and links only; listings are not shown again. */
      readonly saved?: { readonly hadListings: boolean };
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

/** The calls the widget makes besides the message; tests pass stubs. */
export interface WidgetApi {
  readonly list: typeof listConversations;
  readonly read: typeof readConversation;
  readonly remove: typeof deleteConversation;
  readonly feedback: typeof sendFeedback;
}
const REAL_API: WidgetApi = {
  list: listConversations,
  read: readConversation,
  remove: deleteConversation,
  feedback: sendFeedback,
};

type History =
  | { readonly state: 'loading'; readonly items: readonly ConversationSummary[] }
  | {
      readonly state: 'error';
      readonly items: readonly ConversationSummary[];
      readonly why: string;
    }
  | {
      readonly state: 'ready';
      readonly items: readonly ConversationSummary[];
      readonly next: string | null;
    };

/** What the thumbs of one answer show: the choice, the reason and whether the server took it. */
interface Rating {
  readonly id: number;
  readonly value: 'up' | 'down';
  readonly reason: FeedbackReason | null;
  readonly failed: boolean;
}

const REASONS: readonly FeedbackReason[] = ['wrong', 'not-found', 'other'];

let nextId = 1;
const welcome = (): Entry => ({ id: nextId++, role: 'assistant', kind: 'welcome' });

/** Matches the sheet breakpoint of the CSS: under 700px (the phone) is a full-screen modal sheet. */
function useSheet(): boolean {
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(under('tablet'));
    const update = () => setSheet(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return sheet;
}

/**
 * Keeps the launcher above the bottom dock (tab bar, cookie bar), above the page's action bar (buy
 * bar, checkout bar) and, at the end of the page, above the footer's back-to-top button, so it
 * never covers any of them. Writes `--as-dock` and `--as-lift`, and `data-covered` while the launcher
 * hides on a phone with the cookie bar open.
 */
function useLift(root: HTMLElement | null) {
  useEffect(() => {
    if (!root) return;
    const html = document.documentElement;
    // The product page's tab bar slides away on a phone (shell/tabbar-autohide.tsx) and the buy bar
    // drops with it. While that moves, the launcher keeps to the higher, tab bar shown geometry.
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return rect.height > 0 ? { top: rect.top, bottom: rect.bottom } : null;
    };
    const dockHeight = () => document.querySelector<HTMLElement>('.dock')?.offsetHeight ?? 0;
    const gap = () => {
      const value = Number.parseFloat(getComputedStyle(html).getPropertyValue('--sf-dock-gap'));
      return Number.isFinite(value) ? value : 13;
    };
    const place = () => {
      const top = document.querySelector('.fbase .btt');
      const hidden = html.getAttribute('data-tabbar') === 'hidden';
      const moving = html.getAttribute('data-tabbar-moving') === 'true';
      const { dock, lift, alignBackToTop } = launcherLift(
        window.innerHeight,
        dockForLauncher(box(document.querySelector('.dock')), hidden, moving),
        Array.from(document.querySelectorAll('.buybar, .cbar'), (bar) =>
          moving ? movingBarBox(box(bar), window.innerHeight, dockHeight(), gap()) : box(bar),
        ),
        box(top),
      );
      const phone =
        typeof window.matchMedia === 'function' && window.matchMedia(under('tablet')).matches;
      root.dataset.covered = String(
        launcherHidden(phone, document.querySelector('.consent') !== null),
      );
      root.style.setProperty('--as-dock', `${dock}px`);
      root.style.setProperty('--as-lift', `${lift}px`);
      if (alignBackToTop && top) {
        // Lifted above back-to-top, the launcher lines up with it.
        const rect = top.getBoundingClientRect();
        const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
        root.style.setProperty(
          '--as-end',
          `${Math.round(rtl ? rect.left : document.documentElement.clientWidth - rect.right)}px`,
        );
      } else root.style.removeProperty('--as-end');
    };
    place();
    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    const bar = document.querySelector('.dock');
    if (bar) observer?.observe(bar);
    const tabBar = new MutationObserver(place);
    tabBar.observe(html, {
      attributes: true,
      attributeFilter: ['data-tabbar', 'data-tabbar-moving'],
    });
    return () => {
      tabBar.disconnect();
      window.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [root]);
}

/**
 * The buyer assistant (package 5): a round launcher at the bottom right and the chat panel it
 * opens, docked (non-modal) from 700px and a full-screen modal sheet under 700px. Rendered
 * only when the storefront says the assistant is on for this visitor; with no setup nothing shows.
 * Model sentences are shown as plain text; products and stores are lists of links built from server
 * cards, with the price, seller and badges the card carries (never from model text).
 */
export function AssistantWidget({
  setup,
  send = sendMessage,
  previewToken = null,
  api = REAL_API,
}: {
  readonly setup: AssistantSetup;
  /** The conversation call; tests pass a stub. */
  readonly send?: typeof sendMessage;
  /** The internal preview token in force (memory only; sent as a header, never shown). */
  readonly previewToken?: string | null;
  /** The history and feedback calls; tests pass stubs. */
  readonly api?: WidgetApi;
}) {
  const t = useTranslations('assistant');
  const format = useFormatter();
  const locale = useLocale();
  const money = (value: CardMoney) => formatMoney(value, locale);
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
  const [rating, setRating] = useState<Rating | null>(null);
  const [mode, setMode] = useState<'chat' | 'history'>('chat');
  const [history, setHistory] = useState<History>({ state: 'loading', items: [] });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  /** A one-line result in the list: deleted, gone, or a failed call. */
  const [notice, setNotice] = useState<string | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const conversation = useRef(newConversationId());
  /** Answered turns of this conversation, and whether that count can be trusted (see settle). */
  const turns = useRef(0);
  const turnsKnown = useRef(true);
  const historyAbort = useRef<AbortController | null>(null);
  const misses = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const visitor = useRef<string | null>(null);
  const limitWait = useRef(60);
  /** Bumped by New chat, so an answer to the old chat never lands in the new one. */
  const generation = useRef(0);

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
  }, [entries, busy, slow, open, rating]);
  // The limit banner clears itself once the server's wait is over.
  useEffect(() => {
    if (banner !== 'limit') return;
    const timer = window.setTimeout(() => setBanner(null), limitWait.current * 1000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const push = (entry: Entry) => setEntries((list) => [...list, entry]);

  /** A signed-in customer's write carries the session's token: this tab's, the page's, a fresh read. */
  const csrfFor = async (): Promise<string | null> =>
    customer === null
      ? null
      : (customerApi.knownCsrfToken() ?? setup.csrfToken ?? (await customerApi.currentCsrfToken()));

  /**
   * A turn whose outcome is unknown (the network failed, or the buyer pressed Stop) may or may not
   * be stored, so the position of the next answer is unknown too. A customer's count is read back
   * from the server; a guest's chat shows no thumbs until it is a new chat. Never a guess.
   */
  const uncertain = (convo: string) => {
    turnsKnown.current = false;
    if (customer === null) return;
    const started = generation.current;
    void api
      .read(setup, convo, new AbortController().signal, undefined, previewToken)
      .then((read) => {
        if (generation.current !== started || conversation.current !== convo) return;
        if (read.ok) {
          turns.current = read.value.turns;
          turnsKnown.current = true;
        } else if (read.refusal.kind === 'lost') {
          turns.current = 0;
          turnsKnown.current = true;
        }
      })
      .catch(() => undefined);
  };

  const settle = (result: SendResult, message: string) => {
    const convo = conversation.current;
    if (result.ok) {
      const missed = result.reply.notices.includes('unavailable');
      misses.current = missed ? misses.current + 1 : 0;
      const support = result.reply.support || misses.current >= 2;
      if (support) misses.current = 0;
      let position: number | null = null;
      if (turnsKnown.current) {
        turns.current += 1;
        position = turns.current * 2 <= 60 ? turns.current * 2 : null;
      }
      push({
        id: nextId++,
        role: 'assistant',
        kind: 'reply',
        reply: result.reply,
        query: message,
        support,
        conversationId: convo,
        position,
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
        turns.current = 0;
        turnsKnown.current = true;
        break;
      case 'error':
        uncertain(convo);
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
    const started = generation.current;
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    let result: SendResult;
    try {
      // A signed-in customer's write carries the session's token: the one this tab holds, else the
      // page's own, else a fresh read of the session. A guest sends none.
      const csrf = await csrfFor();
      result = await send(
        { ...setup, csrfToken: csrf },
        conversation.current,
        message,
        visitor.current,
        controller.signal,
        undefined,
        previewToken,
      );
    } catch {
      result = { ok: false, refusal: { kind: 'error' } };
    }
    window.clearTimeout(timer);
    if (generation.current !== started) return;
    abort.current = null;
    setBusy(false);
    setSlow(false);
    if (controller.signal.aborted) {
      uncertain(conversation.current);
      push({ id: nextId++, role: 'assistant', kind: 'stopped' });
      return;
    }
    settle(result, message);
  };

  const stop = () => abort.current?.abort();

  const restart = () => {
    generation.current += 1;
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setSlow(false);
    conversation.current = newConversationId();
    turns.current = 0;
    turnsKnown.current = true;
    misses.current = 0;
    setEntries([welcome()]);
    setRating(null);
    setMode('chat');
    setConfirming(null);
    setDraft('');
    if (banner === 'full') setBanner(null);
    box.current?.focus();
  };

  // ---- Feedback: a thumbs on the last answer, the reason after a down ----

  const rate = async (
    entry: Extract<Entry, { kind: 'reply' }>,
    value: 'up' | 'down',
    reason: FeedbackReason | null = null,
  ) => {
    setRating({ id: entry.id, value, reason, failed: false });
    // A chat that keeps no text has no message to attach a thumbs to: the buyer still gets the
    // answer to a thumbs down (sorry, support), and nothing is sent.
    if (entry.position === null || setup.retentionDays === 0) return;
    const started = generation.current;
    let sent: Awaited<ReturnType<WidgetApi['feedback']>>;
    try {
      const csrf = await csrfFor();
      sent = await api.feedback(
        { ...setup, csrfToken: csrf },
        entry.conversationId,
        entry.position,
        value,
        value === 'down' ? reason : null,
        undefined,
        previewToken,
      );
    } catch {
      sent = { ok: false, refusal: { kind: 'error' } };
    }
    if (generation.current !== started || sent.ok) return;
    setRating((now) => (now?.id === entry.id ? { ...now, failed: true } : now));
  };

  // ---- History (signed-in buyers) ----

  const historyOpen = customer !== null && setup.retentionDays !== 0;

  const loadHistory = (cursor: string | null) => {
    historyAbort.current?.abort();
    const controller = new AbortController();
    historyAbort.current = controller;
    setHistory((now) =>
      cursor === null ? { state: 'loading', items: [] } : { ...now, state: 'loading' },
    );
    void api.list(setup, cursor, controller.signal, undefined, previewToken).then((result) => {
      if (controller.signal.aborted) return;
      setHistory((now) => {
        if (result.ok) {
          const known = new Set(cursor === null ? [] : now.items.map((item) => item.id));
          return {
            state: 'ready',
            items: [
              ...(cursor === null ? [] : now.items),
              ...result.value.items.filter((item) => !known.has(item.id)),
            ],
            next: result.value.nextCursor,
          };
        }
        return {
          state: 'error',
          items: cursor === null ? [] : now.items,
          why: result.refusal.kind === 'sign-in' ? 'history-sign-in' : 'history-error',
        };
      });
      if (!result.ok && result.refusal.kind === 'off') setStatus('off');
    });
  };

  const showHistory = () => {
    setConfirming(null);
    setNotice(null);
    setMode('history');
    loadHistory(null);
  };

  const backToChat = () => {
    historyAbort.current?.abort();
    setMode('chat');
    setConfirming(null);
  };

  // The list closes when the buyer signs out, and nothing is left running behind it.
  useEffect(() => {
    if (!historyOpen && mode === 'history') backToChat();
  }, [historyOpen]);
  useEffect(() => () => historyAbort.current?.abort(), []);
  // Focus follows the view: the back button in the list, the message box in the chat.
  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    if (mode === 'history')
      el?.querySelector<HTMLElement>('[data-as=hback]')?.focus({ preventScroll: true });
    else if (!sheet) box.current?.focus({ preventScroll: true });
  }, [mode]);

  /** The stored messages as widget entries: text and links only, answers paired with their position. */
  const entriesOf = (stored: StoredConversation): Entry[] => {
    const list: Entry[] = [];
    for (const message of stored.messages) {
      if (message.role === 'user') {
        list.push({ id: nextId++, role: 'user', text: message.text });
        continue;
      }
      list.push({
        id: nextId++,
        role: 'assistant',
        kind: 'reply',
        reply: {
          conversationId: stored.id,
          sentences: message.text === '' ? [] : [message.text],
          products: [],
          sellers: [],
          pages: message.pages,
          cartActions: [],
          carts: [],
          baskets: [],
          support: false,
          notices: [],
        },
        query: '',
        support: message.support,
        conversationId: stored.id,
        position: message.position,
        saved: { hadListings: message.hadListings },
      });
    }
    return list;
  };

  const openConversation = async (item: ConversationSummary) => {
    if (opening !== null) return;
    setOpening(item.id);
    setConfirming(null);
    const controller = new AbortController();
    const result = await api.read(setup, item.id, controller.signal, undefined, previewToken);
    setOpening(null);
    if (!result.ok) {
      if (result.refusal.kind === 'lost')
        setHistory((now) => ({ ...now, items: now.items.filter((row) => row.id !== item.id) }));
      setNotice(result.refusal.kind === 'lost' ? 'history-gone' : 'history-error');
      return;
    }
    // Leave whatever was running; its answer must not land in the chat that is opened now.
    generation.current += 1;
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setSlow(false);
    conversation.current = result.value.id;
    turns.current = result.value.turns;
    turnsKnown.current = true;
    misses.current = 0;
    setEntries(entriesOf(result.value));
    setRating(null);
    setDraft('');
    setBanner(result.value.full ? 'full' : null);
    setNotice(null);
    setMode('chat');
  };

  const removeConversation = async (item: ConversationSummary) => {
    setConfirming(null);
    const csrf = await csrfFor();
    const result = await api.remove(
      { ...setup, csrfToken: csrf },
      item.id,
      undefined,
      previewToken,
    );
    // 404: already gone, which is what the buyer asked for.
    if (!result.ok && result.refusal.kind !== 'lost') {
      setNotice('history-delete-failed');
      return;
    }
    setNotice('history-deleted');
    setHistory((now) => ({ ...now, items: now.items.filter((row) => row.id !== item.id) }));
    // The chat that is open was deleted: its id is gone for good (POST answers 404), start fresh.
    if (conversation.current === item.id) {
      generation.current += 1;
      abort.current?.abort();
      abort.current = null;
      setBusy(false);
      conversation.current = newConversationId();
      turns.current = 0;
      turnsKnown.current = true;
      misses.current = 0;
      setEntries([welcome()]);
      setRating(null);
      if (banner === 'full') setBanner(null);
    }
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
  // 0 days means the chat is not kept; null means the number is unknown.
  const days =
    setup.retentionDays === null
      ? 'unknown'
      : setup.retentionDays === 0
        ? 'none'
        : String(setup.retentionDays);
  const prompts =
    setup.quickPrompts !== undefined && setup.quickPrompts.length > 0
      ? setup.quickPrompts
      : QUICK_PROMPTS.map((key) => t(key));
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

  const chips = (texts: readonly string[], label: string) => (
    <div className="asqp" role="group" aria-label={label}>
      {texts.map((text) => (
        <button className="aschip" type="button" key={text} onClick={() => void ask(text)}>
          {text}
        </button>
      ))}
    </div>
  );

  const replyBody = (entry: Extract<Entry, { kind: 'reply' }>) => {
    const { reply } = entry;
    const said = reply.sentences.join(' ');
    if (entry.saved !== undefined) {
      const savedPages = reply.pages
        .map((card) => ({ card, href: pagePath(card) }))
        .filter((page): page is { card: typeof page.card; href: string } => page.href !== null);
      return (
        <>
          {said !== '' ? <div className="asb">{said}</div> : null}
          {entry.saved.hadListings ? <div className="asnote">{t('history-listings')}</div> : null}
          {savedPages.length > 0 ? (
            <div className="aslinks">
              {savedPages.map(({ card, href }) => (
                <button className="aslk" type="button" key={card.page} onClick={() => go(href)}>
                  {t(`page-${card.page}`)}
                  <Icon name="chevr" />
                </button>
              ))}
            </div>
          ) : null}
          {entry.support ? supportCard : null}
        </>
      );
    }
    const nothing =
      said === '' &&
      reply.products.length === 0 &&
      reply.sellers.length === 0 &&
      reply.pages.length === 0 &&
      reply.cartActions.length === 0 &&
      reply.carts.length === 0 &&
      reply.baskets.length === 0 &&
      reply.notices.length === 0 &&
      !entry.support;
    if (nothing) {
      return (
        <>
          <div className="asb">{t('empty')}</div>
          {chips(
            ['empty-halal', 'empty-categories', 'empty-offers'].map((key) => t(key)),
            t('empty-label'),
          )}
        </>
      );
    }
    const pages = reply.pages
      .map((card) => ({ card, href: pagePath(card) }))
      .filter((page): page is { card: typeof page.card; href: string } => page.href !== null);
    return (
      <>
        {said !== '' || reply.products.length > 0 || reply.sellers.length > 0 ? (
          <div className="asb">
            {said !== '' ? said : t('found')}
            {reply.products.length > 0 ? (
              <ul className="aslist">
                {reply.products.map((card) => (
                  <li key={card.offerId}>
                    <Link
                      href={productHref(card.productId, card.name)}
                      onClick={() => sheet && setOpen(false)}
                    >
                      {card.name}
                    </Link>
                    {card.sellerName ? (
                      <small>{t('sold-by', { seller: card.sellerName })}</small>
                    ) : null}
                    {card.shortText ? <small>{card.shortText}</small> : null}
                    {card.price === null ? null : (
                      <div className="asprice num">
                        {card.regularPrice === null ? null : (
                          <span className="asvh">{t('special-price')}, </span>
                        )}
                        <b className={card.regularPrice === null ? undefined : 'sp'}>
                          {card.priceFrom
                            ? t('price-from', { price: money(card.price) })
                            : money(card.price)}
                        </b>
                        {card.regularPrice === null ? null : (
                          <s>
                            <span className="asvh">{t('regular-price')}, </span>
                            {money(card.regularPrice)}
                          </s>
                        )}
                        {card.taxInclusive === true ? <small>{t('including-gst')}</small> : null}
                      </div>
                    )}
                    {card.badges.length > 0 ? (
                      <div className="asbadges">
                        {card.badges.map((badge) => (
                          <span
                            key={badge.typeCode}
                            className={badge.sellerClaim ? 'badge decl' : 'badge hl'}
                          >
                            {badge.sellerClaim
                              ? t('declared-chip', { name: badge.typeName })
                              : badge.typeName}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {reply.sellers.length > 0 ? (
              <ul className="aslist" aria-label={t('store-label')}>
                {reply.sellers.map((card) => {
                  const meta = [
                    card.city,
                    card.sellingSince === null
                      ? null
                      : t('store-since', { year: String(card.sellingSince) }),
                    card.productCount === null
                      ? null
                      : t('store-products', { count: card.productCount }),
                  ].filter((part): part is string => part !== null);
                  return (
                    <li key={card.sellerId}>
                      <span className="astag">
                        <Icon name="store" />
                        {t('store-tag')}
                      </span>
                      <Link href={`/s/${card.slug}`} onClick={() => sheet && setOpen(false)}>
                        {card.name}
                      </Link>
                      {meta.length > 0 ? <small>{meta.join(' · ')}</small> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
        {reply.baskets.map((card, at) => (
          <BasketProposalCardView
            key={`basket-${at}`}
            card={card}
            onNavigate={() => sheet && setOpen(false)}
          />
        ))}
        {reply.cartActions.map((card, at) => (
          <CartActionCardView
            key={`action-${at}-${card.offerId}`}
            card={card}
            onNavigate={() => sheet && setOpen(false)}
          />
        ))}
        {reply.carts.map((card, at) => (
          <CartSummaryCardView
            key={`cart-${at}`}
            card={card}
            onNavigate={() => sheet && setOpen(false)}
          />
        ))}
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
        {reply.notices
          // The product note already says where prices and certificates are.
          .filter(
            (code) =>
              reply.products.length === 0 || (code !== 'see-cards' && code !== 'see-certification'),
          )
          .map((code) => (
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
            {chips(prompts, t('quick-label'))}
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
        {isLast && entry.kind === 'reply' ? (
          <>
            <div className="asfb" role="group" aria-label={t('rate')}>
              <button
                type="button"
                aria-label={t('good')}
                aria-pressed={rating?.id === entry.id && rating.value === 'up'}
                onClick={() => void rate(entry, 'up')}
              >
                <Icon name="thumb-up" />
              </button>
              <button
                type="button"
                aria-label={t('bad')}
                aria-pressed={rating?.id === entry.id && rating.value === 'down'}
                onClick={() => void rate(entry, 'down')}
              >
                <Icon name="thumb-down" />
              </button>
            </div>
            {rating?.id === entry.id ? (
              <div className="asnote" role="status">
                {rating.failed
                  ? t('feedback-failed')
                  : rating.value === 'down'
                    ? t('sorry')
                    : entry.position !== null && setup.retentionDays !== 0
                      ? t('thanks')
                      : null}
              </div>
            ) : null}
            {rating?.id === entry.id && rating.value === 'down' ? (
              <>
                {entry.position !== null && setup.retentionDays !== 0 ? (
                  <div className="asqp" role="group" aria-label={t('reason-label')}>
                    {REASONS.map((reason) => (
                      <button
                        className="aschip"
                        type="button"
                        key={reason}
                        aria-pressed={rating.reason === reason}
                        onClick={() => void rate(entry, 'down', reason)}
                      >
                        {t(`reason-${reason}`)}
                      </button>
                    ))}
                  </div>
                ) : null}
                {entry.support ? null : supportCard}
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

  const historyView = (
    <div className="ashist">
      <div className="ashh">
        <button className="aslk" type="button" data-as="hback" onClick={backToChat}>
          <Icon name="chevl" />
          {t('history-back')}
        </button>
        <h3>{t('history-title')}</h3>
      </div>
      <p className="asnote">{t('history-kept', { days })}</p>
      {notice !== null ? (
        <div className="asnote" role="status">
          {t(notice)}
        </div>
      ) : null}
      {history.state === 'error' ? (
        <div className="asb err" role="alert">
          <Icon name="warn" />
          <span>{t(history.why)}</span>
        </div>
      ) : null}
      {history.state === 'loading' && history.items.length === 0 ? (
        <div className="asnote" role="status">
          {t('history-loading')}
        </div>
      ) : null}
      {history.state === 'ready' && history.items.length === 0 ? (
        <div className="asstate">
          <p>{t('history-empty')}</p>
          <button className="btn small" type="button" onClick={restart}>
            {t('new-chat-short')}
          </button>
        </div>
      ) : null}
      {history.items.length > 0 ? (
        <ul className="ashl" aria-label={t('history-title')}>
          {history.items.map((item) => {
            const title = item.title === '' ? t('history-untitled') : item.title;
            const when = format.dateTime(new Date(item.lastMessageAt), { dateStyle: 'medium' });
            return (
              <li key={item.id} data-current={conversation.current === item.id}>
                <button
                  className="ashopen"
                  type="button"
                  disabled={opening !== null}
                  aria-busy={opening === item.id}
                  onClick={() => void openConversation(item)}
                >
                  <span className="ashtt">{title}</span>
                  <small>
                    {when} · {t('history-turns', { count: item.turns })}
                    {item.full ? ` · ${t('history-full')}` : ''}
                  </small>
                </button>
                <button
                  className="ashdel"
                  type="button"
                  aria-label={t('history-delete', { title })}
                  aria-expanded={confirming === item.id}
                  onClick={() => setConfirming(confirming === item.id ? null : item.id)}
                >
                  <Icon name="trash" />
                </button>
                {confirming === item.id ? (
                  <div className="ashconf" role="group" aria-label={t('history-confirm')}>
                    <span>{t('history-confirm')}</span>
                    <button
                      className="btn small"
                      type="button"
                      onClick={() => void removeConversation(item)}
                    >
                      {t('history-delete-yes')}
                    </button>
                    <button
                      className="btn small ghost"
                      type="button"
                      onClick={() => setConfirming(null)}
                    >
                      {t('cart-cancel')}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {history.state === 'ready' && history.next !== null ? (
        <button className="btn small ghost" type="button" onClick={() => loadHistory(history.next)}>
          {t('history-more')}
        </button>
      ) : null}
    </div>
  );

  if (!mounted) return null;
  return createPortal(
    <div className="asw" ref={setRoot} data-open={open} data-off={status === 'off'}>
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
        aria-describedby={setup.preview === true ? 'as-preview-note' : undefined}
        hidden={!open}
      >
        <div className="ash">
          <span className="asav" aria-hidden="true">
            <Icon name="spark" />
          </span>
          <div className="ashm">
            <h2 id="as-title">
              {t('title')}
              {setup.preview === true ? (
                <span className="aspreview" title={t('preview-note')}>
                  {t('preview')}
                </span>
              ) : null}
              {setup.preview === true ? (
                <span className="asvh" id="as-preview-note">
                  {t('preview-note')}
                </span>
              ) : null}
            </h2>
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
          {view === 'chat' && historyOpen ? (
            <button
              className="asx"
              type="button"
              data-as="history"
              aria-label={t('history-open')}
              title={t('history-open')}
              aria-pressed={mode === 'history'}
              onClick={() => (mode === 'history' ? backToChat() : showHistory())}
            >
              <Icon name="clock" />
            </button>
          ) : null}
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
        {view === 'chat' && mode === 'history' ? (
          historyView
        ) : view === 'chat' ? (
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
