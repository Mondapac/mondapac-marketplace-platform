import { describe, expect, it } from 'vitest';
import type { NavItem } from '../shell/nav.ts';
import { moveActive } from './palette-nav.ts';
import {
  buildPaletteEntries,
  matchPage,
  searchPalette,
  type PaletteSources,
} from './palette-index.ts';
import {
  PIN_LIMIT,
  defaultPins,
  prefsKey,
  pushRecent,
  readIds,
  resolvePins,
  togglePin,
  writeIds,
} from './panel-prefs.ts';
import {
  IDLE_CHORD,
  interpretKey,
  isEditableTarget,
  type Chord,
  type ShortcutAction,
} from './shortcuts.ts';

const navItems: readonly NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'home', href: '/' },
  { id: 'orders', labelKey: 'nav.orders', icon: 'receipt', href: '/orders', anyOf: ['o.view'] },
  { id: 'sellers', labelKey: 'nav.sellers', icon: 'store', href: '/sellers', anyOf: ['s.view'] },
];
const text: Record<string, string> = {
  'nav.home': 'Home',
  'nav.orders': 'Orders',
  'nav.sellers': 'Sellers',
  'page.support': 'Support contact',
  'page.delivery': 'Delivery rules',
  'group.market': 'Marketplace',
  'set.email': 'Support email',
  'set.fee': 'Delivery fee',
  'set.fee-words': 'markup, charge',
  'act.role': 'Create role',
};
const sources = (permissionKeys: readonly string[]): PaletteSources => ({
  label: (key) => text[key] ?? key,
  permissionKeys,
  navItems,
  settingsPages: [
    {
      id: 'support',
      labelKey: 'page.support',
      href: '/settings/support',
      view: ['sup.view'],
      groupLabelKey: 'group.market',
      groupIcon: 'store',
    },
    {
      id: 'delivery',
      labelKey: 'page.delivery',
      href: '/settings/delivery',
      view: ['del.view'],
      groupLabelKey: 'group.market',
      groupIcon: 'package',
    },
    {
      id: 'mine',
      labelKey: 'page.support',
      href: '/account/profile',
      groupLabelKey: 'group.market',
      groupIcon: 'user',
    },
  ],
  settings: [
    { id: 'support-email', pageId: 'support', labelKey: 'set.email' },
    { id: 'delivery-fee', pageId: 'delivery', labelKey: 'set.fee', keywordsKey: 'set.fee-words' },
  ],
  actions: [
    { id: 'role', labelKey: 'act.role', href: '/roles/new', icon: 'users', anyOf: ['r.new'] },
  ],
});
const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);

describe('buildPaletteEntries', () => {
  it('shows only what the permission keys allow, by the menu rule (anyOf, none = always)', () => {
    expect(ids(buildPaletteEntries(sources([])))).toEqual(['page:home', 'page:settings/mine']);
    expect(ids(buildPaletteEntries(sources(['o.view', 'sup.view', 'r.new'])))).toEqual([
      'page:home',
      'page:orders',
      'page:settings/support',
      'page:settings/mine',
      'setting:support-email',
      'action:role',
    ]);
  });

  it('shows a setting only with its page, and links it to the row anchor', () => {
    const entries = buildPaletteEntries(sources(['del.view']));
    expect(ids(entries)).toContain('setting:delivery-fee');
    expect(ids(entries)).not.toContain('setting:support-email');
    const fee = entries.find((entry) => entry.id === 'setting:delivery-fee');
    expect(fee?.href).toBe('/settings/delivery#setting-delivery-fee');
    expect(fee?.context).toBe('Delivery rules');
  });
});

describe('searchPalette', () => {
  const entries = buildPaletteEntries(
    sources(['o.view', 's.view', 'sup.view', 'del.view', 'r.new']),
  );

  it('finds a setting by its label, its words and its page, best match first', () => {
    expect(ids(searchPalette(entries, 'delivery'))[0]).toBe('page:settings/delivery');
    expect(ids(searchPalette(entries, 'fee'))).toEqual(['setting:delivery-fee']);
    expect(ids(searchPalette(entries, 'markup'))).toEqual(['setting:delivery-fee']);
    expect(ids(searchPalette(entries, 'support email'))).toEqual(['setting:support-email']);
  });

  it('requires every word, ignores case and extra spaces, and returns nothing for an empty query', () => {
    expect(ids(searchPalette(entries, '  CREATE   role '))).toEqual(['action:role']);
    expect(searchPalette(entries, 'create sellers')).toEqual([]);
    expect(searchPalette(entries, '   ')).toEqual([]);
  });

  it('never returns an entry the keys did not allow', () => {
    const few = buildPaletteEntries(sources([]));
    expect(searchPalette(few, 'orders')).toEqual([]);
    expect(searchPalette(few, 'delivery fee')).toEqual([]);
  });
});

describe('matchPage', () => {
  const entries = buildPaletteEntries(sources(['o.view', 'sup.view']));
  it('matches a path exactly or by its parent page, and home only itself', () => {
    expect(matchPage(entries, '/orders')?.id).toBe('page:orders');
    expect(matchPage(entries, '/orders/42/')?.id).toBe('page:orders');
    expect(matchPage(entries, '/settings/support')?.id).toBe('page:settings/support');
    expect(matchPage(entries, '/')?.id).toBe('page:home');
    expect(matchPage(entries, '/unknown')).toBeUndefined();
  });
});

describe('moveActive', () => {
  it('moves with the arrows, wraps at both ends and has no active option without results', () => {
    expect(moveActive(0, 3, 'ArrowDown')).toBe(1);
    expect(moveActive(2, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2);
    expect(moveActive(-1, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(-1, 3, 'ArrowUp')).toBe(2);
    expect(moveActive(1, 3, 'Home')).toBe(0);
    expect(moveActive(1, 3, 'End')).toBe(2);
    expect(moveActive(0, 0, 'ArrowDown')).toBe(-1);
  });
});

describe('pins and recents', () => {
  it('pins up to five pages and refuses a sixth without changing anything', () => {
    let pins: readonly string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const change = togglePin(pins, id);
      expect(change.kind).toBe('pinned');
      pins = change.pins;
    }
    expect(pins).toHaveLength(PIN_LIMIT);
    const sixth = togglePin(pins, 'f');
    expect(sixth.kind).toBe('limit');
    expect(sixth.pins).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(togglePin(pins, 'c')).toEqual({ kind: 'unpinned', pins: ['a', 'b', 'd', 'e'] });
  });

  it('keeps the last five recent pages, newest first, without duplicates', () => {
    let recent: readonly string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) recent = pushRecent(recent, id);
    expect(recent).toEqual(['c', 'f', 'e', 'd', 'b']);
  });

  it('uses the role defaults until something is saved, and drops pages no longer allowed', () => {
    const valid = new Set(['a', 'b', 'c', 'd']);
    expect(resolvePins(undefined, ['a', 'b', 'x'], valid)).toEqual(['a', 'b']);
    expect(resolvePins(['d', 'x', 'd', 'c'], ['a'], valid)).toEqual(['d', 'c']);
    expect(resolvePins([], ['a'], valid)).toEqual([]);
    expect(resolvePins(['a', 'b', 'c', 'd', 'a'], [], new Set(['a', 'b', 'c', 'd']), 3)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('drops repeated candidates and picks three default pins from a role candidates that it may open', () => {
    expect(defaultPins(['x', 'a', 'a', 'b', 'c', 'd'], new Set(['a', 'b', 'c', 'd']))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keys the lists by panel, Market and account', () => {
    expect(prefsKey('admin', 'AU', 'u1', 'pins')).toBe('mp:admin:AU:u1:pins');
    expect(prefsKey('admin', 'NZ', 'u1', 'pins')).not.toBe(prefsKey('admin', 'AU', 'u1', 'pins'));
  });

  it('reads and writes through storage, and works when storage is missing or throws', () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
    expect(writeIds(store, 'k', ['a', 'b'])).toBe(true);
    expect(readIds(store, 'k')).toEqual(['a', 'b']);
    data.set('bad', '{not json');
    expect(readIds(store, 'bad')).toBeUndefined();
    data.set('obj', '{"a":1}');
    expect(readIds(store, 'obj')).toBeUndefined();

    expect(readIds(null, 'k')).toBeUndefined();
    expect(writeIds(null, 'k', ['a'])).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readIds(broken, 'k')).toBeUndefined();
    expect(writeIds(broken, 'k', ['a'])).toBe(false);
  });
});

describe('interpretKey', () => {
  const chords: readonly Chord[] = [
    { id: 'go-settings', keys: ['g', 's'] },
    { id: 'go-orders', keys: ['g', 'o'] },
  ];
  const key = (value: string, over: Partial<KeyboardEventInit> = {}) => ({
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...over,
  });
  const body = fakeTarget('div');
  const field = fakeTarget('input');

  function press(
    sequence: readonly [string, number][],
    target: EventTarget | null = body,
    modalOpen = false,
  ) {
    let state = IDLE_CHORD;
    let last: ShortcutAction = { kind: 'none' };
    for (const [value, now] of sequence) {
      const result = interpretKey(key(value), { target, modalOpen, state, now, chords });
      state = result.state;
      last = result.action;
    }
    return last;
  }

  it('completes G then S and G then O inside the window, and not after it', () => {
    expect(
      press([
        ['g', 0],
        ['s', 500],
      ]),
    ).toEqual({ kind: 'chord', chord: chords[0] });
    expect(
      press([
        ['g', 0],
        ['o', 500],
      ]),
    ).toEqual({ kind: 'chord', chord: chords[1] });
    expect(
      press([
        ['g', 0],
        ['s', 5000],
      ]),
    ).toEqual({ kind: 'none' });
    expect(press([['s', 0]])).toEqual({ kind: 'none' });
    expect(
      press([
        ['g', 0],
        ['x', 100],
        ['s', 200],
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('opens the shortcuts list with ?', () => {
    expect(press([['?', 0]])).toEqual({ kind: 'help' });
  });

  it('ignores shortcuts while focus is in an input, textarea, select or contenteditable', () => {
    for (const target of [
      field,
      fakeTarget('textarea'),
      fakeTarget('select'),
      fakeTarget('div', { contenteditable: 'true' }),
    ]) {
      expect(isEditableTarget(target)).toBe(true);
      expect(
        press(
          [
            ['g', 0],
            ['s', 100],
          ],
          target,
        ),
      ).toEqual({ kind: 'none' });
      expect(press([['?', 0]], target)).toEqual({ kind: 'none' });
    }
    expect(isEditableTarget(body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('opens the palette with Ctrl+K or Cmd+K, even from a field', () => {
    for (const over of [{ ctrlKey: true }, { metaKey: true }]) {
      const result = interpretKey(key('k', over), {
        target: field,
        modalOpen: true,
        state: IDLE_CHORD,
        now: 0,
        chords,
      });
      expect(result.action).toEqual({ kind: 'palette' });
    }
  });

  it('ignores chords while a modal is open and with modifier keys held', () => {
    expect(
      press(
        [
          ['g', 0],
          ['s', 100],
        ],
        body,
        true,
      ),
    ).toEqual({ kind: 'none' });
    const withCtrl = interpretKey(key('g', { ctrlKey: true }), {
      target: body,
      modalOpen: false,
      state: IDLE_CHORD,
      now: 0,
      chords,
    });
    expect(withCtrl.action).toEqual({ kind: 'none' });
  });
});

/** A bare object shaped like the element parts `isEditableTarget` reads (this file runs in Node). */
function fakeTarget(tag: string, attributes: Record<string, string> = {}): EventTarget {
  return {
    tagName: tag.toUpperCase(),
    isContentEditable: attributes['contenteditable'] === 'true',
    getAttribute: (name: string) => attributes[name] ?? null,
  } as unknown as EventTarget;
}
