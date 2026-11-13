// The state of the feature set editor (attributes package A4, screen 01) and what it can do to
// it, as pure functions: the editor component only calls these and renders. The API checks every
// rule again; these keep the screen from offering what would be refused.

import type { FeatureSetDetail, Localized, RequirementLevel } from './types.ts';

export const CORE_GROUP = 'core';

export interface EditorEntry {
  readonly code: string;
  /** For display only: never sent. Needed to read the attribute's choices in the preview. */
  readonly attributeId?: string | null;
  readonly level: RequirementLevel;
  /** For display only: never sent. */
  readonly names: Localized | null;
  readonly dataType: string | null;
  readonly isVariantOption: boolean;
  readonly material: boolean;
}

export interface EditorGroup {
  readonly groupCode: string;
  readonly names: Localized;
  readonly entries: readonly EditorEntry[];
}

export interface EditorState {
  readonly names: Localized;
  readonly groups: readonly EditorGroup[];
}

export interface EditRequest {
  readonly version: number;
  readonly names: Localized;
  readonly groups: readonly {
    readonly groupCode: string;
    readonly names: Localized;
    readonly attributes: readonly { readonly code: string; readonly level: RequirementLevel }[];
  }[];
}

export function fromDetail(detail: FeatureSetDetail): EditorState {
  return {
    names: { ...(detail.names ?? {}) },
    groups: detail.groups.map((group) => ({
      groupCode: group.groupCode,
      names: { ...(group.names ?? {}) },
      entries: group.attributes.map((entry) => ({
        code: entry.code,
        attributeId: entry.attributeId,
        level: entry.level ?? (entry.required ? 'required' : 'optional'),
        names: entry.names,
        dataType: entry.dataType,
        isVariantOption: entry.isVariantOption,
        material: entry.material === true,
      })),
    })),
  };
}

/** A name map without the languages left empty (the API wants a name or no key). */
function filled(names: Localized): Localized {
  return Object.fromEntries(
    Object.entries(names)
      .map(([locale, name]) => [locale, name.trim()] as const)
      .filter(([, name]) => name !== ''),
  );
}

export function toRequest(state: EditorState, version: number): EditRequest {
  return {
    version,
    names: filled(state.names),
    groups: state.groups.map((group) => ({
      groupCode: group.groupCode,
      names: filled(group.names),
      attributes: group.entries.map(({ code, level }) => ({ code, level })),
    })),
  };
}

export function isDirty(before: EditorState, after: EditorState): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** `list` with the item at `index` moved by `by` places; unchanged when that falls outside. */
export function moved<T>(list: readonly T[], index: number, by: -1 | 1): readonly T[] {
  const target = index + by;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** The core group stays first and cannot be moved, renamed away or emptied by the editor. */
export function isCore(group: EditorGroup): boolean {
  return group.groupCode === CORE_GROUP;
}

export function moveGroup(state: EditorState, index: number, by: -1 | 1): EditorState {
  const group = state.groups[index];
  const other = state.groups[index + by];
  if (group === undefined || other === undefined || isCore(group) || isCore(other)) return state;
  return { ...state, groups: moved(state.groups, index, by) };
}

export function removeGroup(state: EditorState, index: number): EditorState {
  const group = state.groups[index];
  if (group === undefined || isCore(group)) return state;
  return { ...state, groups: state.groups.filter((_, i) => i !== index) };
}

export function addGroup(state: EditorState, groupCode: string, names: Localized): EditorState {
  if (state.groups.some((group) => group.groupCode === groupCode)) return state;
  return { ...state, groups: [...state.groups, { groupCode, names, entries: [] }] };
}

export function renameGroup(state: EditorState, index: number, names: Localized): EditorState {
  return withGroup(state, index, (group) => ({ ...group, names }));
}

function withGroup(
  state: EditorState,
  index: number,
  change: (group: EditorGroup) => EditorGroup,
): EditorState {
  const group = state.groups[index];
  if (group === undefined) return state;
  return { ...state, groups: state.groups.map((g, i) => (i === index ? change(g) : g)) };
}

export function moveEntry(
  state: EditorState,
  groupIndex: number,
  entryIndex: number,
  by: -1 | 1,
): EditorState {
  return withGroup(state, groupIndex, (group) => ({
    ...group,
    entries: moved(group.entries, entryIndex, by),
  }));
}

export function removeEntry(
  state: EditorState,
  groupIndex: number,
  entryIndex: number,
): EditorState {
  return withGroup(state, groupIndex, (group) => ({
    ...group,
    entries: group.entries.filter((_, i) => i !== entryIndex),
  }));
}

export function setLevel(
  state: EditorState,
  groupIndex: number,
  entryIndex: number,
  level: RequirementLevel,
): EditorState {
  return withGroup(state, groupIndex, (group) => ({
    ...group,
    entries: group.entries.map((entry, i) => (i === entryIndex ? { ...entry, level } : entry)),
  }));
}

/** Adds an attribute at the end of a group unless the set already holds it in any group. */
export function addEntry(state: EditorState, groupIndex: number, entry: EditorEntry): EditorState {
  if (codesOf(state).has(entry.code)) return state;
  return withGroup(state, groupIndex, (group) => ({
    ...group,
    entries: [...group.entries, entry],
  }));
}

export function codesOf(state: EditorState): ReadonlySet<string> {
  return new Set(state.groups.flatMap((group) => group.entries.map((entry) => entry.code)));
}

export function variantCount(state: EditorState): number {
  return state.groups.flatMap((group) => group.entries).filter((entry) => entry.isVariantOption)
    .length;
}

/**
 * The attributes that become required with this edit: added as required, or raised to it. Live
 * products stay on sale and are asked for them at their next submit (decision ت۷), which is what
 * the impact callout says.
 */
export function tightened(before: EditorState, after: EditorState): readonly string[] {
  const was = new Map(
    before.groups.flatMap((group) =>
      group.entries.map((entry) => [entry.code, entry.level] as const),
    ),
  );
  return after.groups
    .flatMap((group) => group.entries)
    .filter((entry) => entry.level === 'required' && was.get(entry.code) !== 'required')
    .map((entry) => entry.code);
}

/** The material attributes taken out: a removal that needs the two-person request. */
export function removedMaterial(before: EditorState, after: EditorState): readonly string[] {
  const kept = codesOf(after);
  return before.groups
    .flatMap((group) => group.entries)
    .filter((entry) => entry.material && !kept.has(entry.code))
    .map((entry) => entry.code);
}
