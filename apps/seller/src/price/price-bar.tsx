'use client';

import {
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

/** One editable part of the prices page: a variant's regular price, or its special price. */
export interface PricePart {
  readonly dirty: boolean;
  /** Shows the part's own field errors; false keeps the run from starting. */
  readonly check: () => boolean;
  /** Sends the part. It shows its own refusal; `stopped` ends the run (code closed, signed out). */
  readonly save: () => Promise<SectionResult>;
  readonly discard: () => void;
}

/** What a saved part says: in force now (`success`), or news such as waiting for review (`info`). */
export interface SavedNote {
  readonly message: string;
  readonly tone: 'success' | 'info';
}

interface Registry {
  readonly register: (key: string, part: PricePart) => void;
  readonly unregister: (key: string) => void;
  readonly markDirty: (key: string, dirty: boolean) => void;
  readonly note: (key: string, note: SavedNote) => void;
  readonly signedOut: () => SectionResult;
}

/** Outside the form (a test of one row): the plain redirect and the part's own toast. */
const ALONE: Registry = {
  register: () => undefined,
  unregister: () => undefined,
  markDirty: () => undefined,
  note: (_key, note) => {
    if (note.tone === 'success') toast.success(note.message);
    else toast.info(note.message);
  },
  signedOut: () => {
    window.location.assign('/session-ended');
    return 'stopped';
  },
};

const PriceBarContext = createContext<Registry>(ALONE);
const SavingContext = createContext(false);

/** Registers a part with the prices page's save bar; the latest closures are read at Save time. */
export function usePricePart(
  key: string,
  part: PricePart,
): {
  readonly saving: boolean;
  readonly note: (note: SavedNote) => void;
  readonly signedOut: () => SectionResult;
} {
  const registry = useContext(PriceBarContext);
  const saving = useContext(SavingContext);
  useLayoutEffect(() => {
    registry.register(key, part);
  });
  useEffect(() => () => registry.unregister(key), [registry, key]);
  useEffect(() => {
    registry.markDirty(key, part.dirty);
  }, [registry, key, part.dirty]);
  return { saving, note: (note) => registry.note(key, note), signedOut: registry.signedOut };
}

/**
 * The form around an offer's prices, with one save bar. Save checks every changed part, then
 * saves them in `order` (per variant: the regular price, then the special), one after another:
 * each stays its own versioned write, and a price that needs a two-step code asks for its own.
 * A refused part keeps its draft and message while the others save; a closed code dialog ends
 * the run and sends nothing more.
 */
export function PriceBarForm({
  order,
  page,
  enabled,
  children,
}: {
  readonly order: readonly string[];
  readonly page: string;
  /** The member may edit prices: without it there is no bar. */
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const t = useTranslations();
  const parts = useRef(new Map<string, PricePart>());
  const notes = useRef(new Map<string, SavedNote>());
  const formRef = useRef<HTMLFormElement>(null);
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState(false);
  // Bumped after a refused run: focus moves once React has drawn the messages and unlocked the form.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (focusTick > 0) focusFirstProblem(formRef.current);
  }, [focusTick]);

  const dirtyInOrder = order.filter((key) => dirtyKeys.has(key));
  const saves = useSectionSaves(
    dirtyInOrder.map((key) => ({
      key,
      dirty: true,
      save: async () => (await parts.current.get(key)?.save()) ?? 'failed',
    })),
  );

  const registry = useMemo<Registry>(
    () => ({
      register: (key, part) => {
        parts.current.set(key, part);
      },
      unregister: (key) => {
        parts.current.delete(key);
        setDirtyKeys((keys) => without(keys, key));
      },
      markDirty: (key, dirty) =>
        setDirtyKeys((keys) =>
          dirty === keys.has(key) ? keys : dirty ? new Set([...keys, key]) : without(keys, key),
        ),
      note: (key, note) => {
        notes.current.set(key, note);
      },
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
      title: t('settings.leave.title'),
      message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
      stay: t('settings.leave.stay'),
      leave: t('settings.leave.leave'),
    },
    { count: saves.count, page },
  );

  async function submit() {
    if (saves.saving || dirtyInOrder.length === 0) return;
    // Every part shows its errors at once; nothing is sent while one is wrong.
    const ok = dirtyInOrder.map((key) => parts.current.get(key)?.check() ?? false).every(Boolean);
    if (!ok) {
      setFocusTick((tick) => tick + 1);
      return;
    }
    notes.current.clear();
    const result = await saves.saveAll();
    if (result === null) return;
    const said = result.saved.flatMap((key) => {
      const note = notes.current.get(key);
      return note === undefined ? [] : [note];
    });
    const saved = result.saved.length;
    if (result.stopped) {
      if (saved > 0) toast.info(t('price.bar.stopped', { saved }));
      return;
    }
    if (result.failed.length === 0) {
      const only = said[0];
      if (saved === 1 && only !== undefined) {
        if (only.tone === 'success') toast.success(only.message);
        else toast.info(only.message);
      } else if (said.every((note) => note.tone === 'success')) {
        toast.success(t('price.bar.saved', { count: saved }));
      } else toast.info(t('price.bar.saved-news', { count: saved }));
      return;
    }
    if (saved > 0) toast.warning(t('price.bar.partial', { saved, failed: result.failed.length }));
    else toast.error(t('price.bar.failed', { count: result.failed.length }));
    setFocusTick((tick) => tick + 1);
  }

  function discard() {
    for (const key of dirtyInOrder) parts.current.get(key)?.discard();
  }

  return (
    <PriceBarContext.Provider value={registry}>
      <SavingContext.Provider value={saves.saving}>
        <form
          ref={formRef}
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {/* Nothing changes while the prices are sent, so each sends what was on screen at Save. */}
          <fieldset
            disabled={saves.saving}
            className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
          >
            {children}
          </fieldset>
          {enabled ? (
            <SaveBar
              count={saves.count}
              summary={t('settings.bar.summary', { count: saves.count })}
              saving={saves.saving}
              aboveBottomBar
              labels={{
                region: t('settings.bar.region'),
                discard: t('settings.bar.discard'),
                save: t('settings.bar.save'),
                saving: t('settings.bar.saving'),
              }}
              onDiscard={discard}
            />
          ) : null}
        </form>
        {saves.count > 0 ? guard.dialog : null}
      </SavingContext.Provider>
    </PriceBarContext.Provider>
  );
}

/** Focuses the first field marked invalid, else the first critical message, inside the form. */
function focusFirstProblem(form: HTMLFormElement | null) {
  const target = form?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]');
  if (target === null || target === undefined) return;
  if (!target.hasAttribute('tabindex') && target.tabIndex < 0)
    target.setAttribute('tabindex', '-1');
  target.focus();
  target.scrollIntoView?.({ block: 'center' });
}

function without(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!keys.has(key)) return keys;
  const next = new Set(keys);
  next.delete(key);
  return next;
}
