'use client';

import {
  Button,
  Dialog,
  SaveBar,
  toast,
  useSectionSaves,
  useUnsavedChangesGuard,
  type SectionResult,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

/**
 * One editable part of the admin seller page (activities, delivery methods, commission rate).
 * Each part keeps its own draft, checks and messages and saves through its own API, with its own
 * two-step code where the server asks for one. The page's one save bar runs them in turn.
 */
export interface SellerSection {
  /** The part has edits not yet saved. */
  readonly dirty: boolean;
  /** The part's name in the confirm list. */
  readonly title: string;
  /** What saving changes, one line each, for the confirm list. */
  readonly lines: readonly string[];
  /** Shows the part's own field errors; false keeps the run from starting. */
  readonly check: () => boolean;
  /** Sends the part. It shows its own refusal; `stopped` ends the run (code cancelled, signed out). */
  readonly save: () => Promise<SectionResult>;
  /** The part's own saved message, used when it is the only part saved. */
  readonly savedMessage: () => string;
  readonly discard: () => void;
}

interface Registry {
  readonly register: (key: string, section: SellerSection) => void;
  readonly unregister: (key: string) => void;
  readonly markDirty: (key: string, dirty: boolean) => void;
  readonly signedOut: () => SectionResult;
}

/** Outside the form: the plain redirect a card made before. */
function signedOutAlone(): SectionResult {
  window.location.assign('/session-ended');
  return 'stopped';
}

const SellerEditContext = createContext<Registry | null>(null);
const SavingContext = createContext(false);

/**
 * Registers a card's part with the page's save bar. Outside a `SellerEditForm` it does nothing,
 * so a card still renders on its own (in a test, or on a page without the bar).
 */
export function useSellerSection(
  key: string,
  section: SellerSection,
): {
  readonly saving: boolean;
  /** A 401 answer: leave for the session-ended page without the leave prompt; ends the run. */
  readonly signedOut: () => SectionResult;
} {
  const registry = useContext(SellerEditContext);
  const saving = useContext(SavingContext);
  // The latest closures, read at Save time: no stale draft is ever sent.
  useLayoutEffect(() => {
    registry?.register(key, section);
  });
  useEffect(() => () => registry?.unregister(key), [registry, key]);
  useEffect(() => {
    registry?.markDirty(key, section.dirty);
  }, [registry, key, section.dirty]);
  return { saving, signedOut: registry?.signedOut ?? signedOutAlone };
}

/**
 * The form around the editable cards of the admin seller page, with one save bar. Save checks
 * every changed part, lists all the changes in one confirm, then saves the parts in `order`, one
 * after another. A refused part keeps its draft and message while the others save; a cancelled
 * code ends the run and sends nothing more. There is no all-or-nothing save: the parts belong to
 * different modules, each with its own API (ADR-0008).
 */
export function SellerEditForm({
  order,
  page,
  children,
}: {
  /** The parts' keys in page order: the order of the confirm list and of the saves. */
  readonly order: readonly string[];
  /** The page's name for the leave prompt. */
  readonly page: string;
  readonly children: ReactNode;
}) {
  const t = useTranslations('sellers.bar');
  const tr = useTranslations();
  const sections = useRef(new Map<string, SellerSection>());
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const dirtyInOrder = order.filter((key) => dirtyKeys.has(key));
  const saves = useSectionSaves(
    dirtyInOrder.map((key) => ({
      key,
      dirty: true,
      save: async () => (await sections.current.get(key)?.save()) ?? 'failed',
    })),
  );

  // Stable for the page's life, so the cards' effects do not re-run on every render.
  const registry = useMemo<Registry>(
    () => ({
      register: (key, section) => {
        sections.current.set(key, section);
      },
      unregister: (key) => {
        sections.current.delete(key);
        setDirtyKeys((keys) => without(keys, key));
      },
      markDirty: (key, dirty) =>
        setDirtyKeys((keys) =>
          dirty === keys.has(key) ? keys : dirty ? withKey(keys, key) : without(keys, key),
        ),
      signedOut: () => {
        flushSync(() => setLeaving(true));
        window.location.assign('/session-ended');
        return 'stopped';
      },
    }),
    [],
  );

  const guard = useUnsavedChangesGuard(
    saves.count > 0 && !leaving,
    {
      title: tr('settings.leave.title'),
      message: (info) => tr('settings.leave.message', { count: info.count, page: info.page }),
      stay: tr('settings.leave.stay'),
      leave: tr('settings.leave.leave'),
    },
    { count: saves.count, page },
  );

  const changed = () =>
    dirtyInOrder.flatMap((key) => {
      const section = sections.current.get(key);
      return section === undefined ? [] : [{ key, section }];
    });

  function submit() {
    if (saves.saving || confirming) return;
    const parts = changed();
    if (parts.length === 0) return;
    // Every part shows its errors at once; nothing is sent while one is wrong.
    const ok = parts.map(({ section }) => section.check()).every(Boolean);
    if (ok) setConfirming(true);
  }

  async function run() {
    const parts = changed();
    // The confirm closes first, so a code dialog never opens on top of it.
    setConfirming(false);
    const result = await saves.saveAll();
    if (result === null) return;
    const saved = result.saved.length;
    if (result.stopped) {
      if (saved > 0) toast.info(t('stopped', { saved }));
      return;
    }
    if (result.failed.length === 0) {
      const only = parts.find((part) => part.key === result.saved[0]);
      if (saved === 1 && only !== undefined) toast.success(only.section.savedMessage());
      else if (saved > 1) toast.success(t('saved', { count: saved }));
    } else if (saved > 0) {
      toast.warning(t('partial', { saved, failed: result.failed.length }));
    }
  }

  function discard() {
    for (const { section } of changed()) section.discard();
  }

  const parts = confirming ? changed() : [];
  return (
    <SellerEditContext.Provider value={registry}>
      <SavingContext.Provider value={saves.saving}>
        <form
          noValidate
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {children}
          <SaveBar
            count={saves.count}
            summary={tr('settings.bar.summary', { count: saves.count })}
            saving={saves.saving}
            labels={{
              region: tr('settings.bar.region'),
              discard: tr('settings.bar.discard'),
              save: tr('settings.bar.save'),
              saving: tr('settings.bar.save'),
            }}
            onDiscard={discard}
          />
        </form>
        {saves.count > 0 ? guard.dialog : null}
        <Dialog
          open={confirming}
          title={t('confirm.title')}
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {t('confirm.cancel')}
              </Button>
              <Button onClick={() => void run()}>{t('confirm.go', { count: parts.length })}</Button>
            </>
          }
        >
          <p className="mb-3">{t('confirm.intro')}</p>
          <ul className="flex flex-col gap-3">
            {parts.map(({ key, section }) => (
              <li key={key}>
                <p className="font-medium">{section.title}</p>
                <ul className="list-disc ps-5 text-sm">
                  {section.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-fg-muted">{t('confirm.codes')}</p>
        </Dialog>
      </SavingContext.Provider>
    </SellerEditContext.Provider>
  );
}

function withKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...keys, key]);
}

function without(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!keys.has(key)) return keys;
  const next = new Set(keys);
  next.delete(key);
  return next;
}
