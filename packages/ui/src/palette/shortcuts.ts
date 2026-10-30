// Keyboard shortcuts of the panels: "G then S" style chords and "?". Pure logic; the provider
// wires it to the document.

/** True when typing here must not trigger a shortcut: a field the person types into. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Element).tagName !== 'string') return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (element.isContentEditable) return true;
  const editable = element.getAttribute('contenteditable');
  return editable !== null && editable !== 'false';
}

export interface Chord {
  readonly id: string;
  /** Two keys pressed one after the other, lower case: `['g', 's']`. */
  readonly keys: readonly [string, string];
}

/** How long the second key of a chord may take. */
export const CHORD_WINDOW_MS = 1200;

export interface ChordState {
  readonly first: string | null;
  readonly at: number;
}

export const IDLE_CHORD: ChordState = { first: null, at: 0 };

/**
 * Feeds one key into the chord tracker. A first key that starts a chord arms it; the matching
 * second key inside the window completes it. Any other key disarms (and may arm a new chord).
 */
export function advanceChord(
  state: ChordState,
  rawKey: string,
  now: number,
  chords: readonly Chord[],
): { readonly state: ChordState; readonly match?: Chord } {
  const key = rawKey.toLowerCase();
  if (state.first !== null && now - state.at <= CHORD_WINDOW_MS) {
    const match = chords.find((chord) => chord.keys[0] === state.first && chord.keys[1] === key);
    if (match !== undefined) return { state: IDLE_CHORD, match };
  }
  const starts = chords.some((chord) => chord.keys[0] === key);
  return { state: starts ? { first: key, at: now } : IDLE_CHORD };
}

export interface KeyInfo {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
}

export type ShortcutAction =
  | { readonly kind: 'palette' }
  | { readonly kind: 'help' }
  | { readonly kind: 'chord'; readonly chord: Chord }
  | { readonly kind: 'none' };

/**
 * What a key press means. Ctrl+K or Cmd+K opens the palette from anywhere, fields included (the
 * usual place for it). Every other shortcut is ignored while focus is in a field or the page has
 * an open modal, and with Ctrl, Cmd or Alt held.
 */
export function interpretKey(
  event: KeyInfo,
  context: {
    readonly target: EventTarget | null;
    readonly modalOpen: boolean;
    readonly state: ChordState;
    readonly now: number;
    readonly chords: readonly Chord[];
  },
): { readonly action: ShortcutAction; readonly state: ChordState } {
  const none = { action: { kind: 'none' }, state: IDLE_CHORD } as const;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    return { action: { kind: 'palette' }, state: IDLE_CHORD };
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return none;
  if (isEditableTarget(context.target) || context.modalOpen) return none;
  if (event.key === '?') return { action: { kind: 'help' }, state: IDLE_CHORD };
  if (event.shiftKey || event.key.length !== 1) return none;
  const next = advanceChord(context.state, event.key, context.now, context.chords);
  return next.match === undefined
    ? { action: { kind: 'none' }, state: next.state }
    : { action: { kind: 'chord', chord: next.match }, state: next.state };
}
