import { at, isRecord, problem, type Problems } from './fields';
import { isModuleKey, parseModuleConfig, type ModuleConfig, type ModuleKey } from './modules';
import {
  MAX_MODULES_PER_SLOT,
  type LinkedType,
  type SlotDefinition,
  type TemplateDefinition,
} from './templates';

// The content of one page version: for each `modules` slot of its template, the ordered list of
// module placements. Every change goes through these functions, so a stored version only ever
// holds modules its slot allows, with checked settings, within the slot's maximum. The minimum is
// checked when a version is published, so a draft may be half-built.

export interface Placement {
  readonly id: string;
  readonly module: ModuleKey;
  /** A placement switched off stays in the draft but is never served. */
  readonly enabled: boolean;
  readonly config: ModuleConfig;
}

export type Placements = Readonly<Record<string, readonly Placement[]>>;

export type PlacementFailure =
  | { readonly code: 'storefront.slot-not-found' }
  | { readonly code: 'storefront.placement-not-found' }
  /** The slot already holds its maximum number of modules. */
  | { readonly code: 'storefront.slot-full' }
  | { readonly code: 'validation.failed'; readonly fields: Problems };

type Change =
  | { readonly ok: true; readonly value: Placements }
  | { readonly ok: false; readonly error: PlacementFailure };

const done = (value: Placements): Change => ({ ok: true, value: Object.freeze(value) });
const failed = (error: PlacementFailure): Change => ({ ok: false, error });
const invalid = (fields: Problems): Change => failed({ code: 'validation.failed', fields });

const maxOf = (slot: SlotDefinition) => Math.min(slot.max, MAX_MODULES_PER_SLOT);

function editableSlot(template: TemplateDefinition, slotKey: string): SlotDefinition | null {
  const slot = template.slots.find((entry) => entry.key === slotKey);
  return slot !== undefined && slot.kind === 'modules' ? slot : null;
}

/** The placements of a new draft: the template's defaults for this page. */
export function defaultPlacements(
  template: TemplateDefinition,
  page: { readonly title: string },
  nextId: () => string,
): Placements {
  const defaults = template.defaults(page);
  const out: Record<string, Placement[]> = {};
  for (const slot of template.slots) {
    if (slot.kind !== 'modules') continue;
    out[slot.key] = (defaults[slot.key] ?? []).slice(0, maxOf(slot)).map((entry) => {
      const parsed = parseModuleConfig(entry.module, entry.config);
      // Defaults are code: one that does not pass its own module's check is a bug.
      if (!parsed.ok || !slot.modules.includes(entry.module)) {
        throw new Error(`storefront.default-invalid:${template.key}.${slot.key}`);
      }
      return { id: nextId(), module: entry.module, enabled: true, config: parsed.config };
    });
  }
  return Object.freeze(out);
}

/**
 * Reads a stored `placements` value back, re-checking every placement against the template as it
 * is now. A placement that no longer fits (a module dropped from a slot, a setting the module no
 * longer accepts) is left out, never served unchecked; `dropped` counts them.
 */
export function readPlacements(
  template: TemplateDefinition,
  stored: unknown,
): { readonly placements: Placements; readonly dropped: number } {
  const out: Record<string, Placement[]> = {};
  let dropped = 0;
  const source = isRecord(stored) ? stored : {};
  for (const slot of template.slots) {
    if (slot.kind !== 'modules') continue;
    const entries = Array.isArray(source[slot.key]) ? (source[slot.key] as unknown[]) : [];
    const kept: Placement[] = [];
    for (const entry of entries) {
      const placement = storedPlacement(slot, entry);
      if (placement === null || kept.length >= maxOf(slot)) dropped += 1;
      else kept.push(placement);
    }
    out[slot.key] = kept;
  }
  for (const key of Object.keys(source)) {
    if (editableSlot(template, key) === null && Array.isArray(source[key])) {
      dropped += (source[key] as unknown[]).length;
    }
  }
  return { placements: Object.freeze(out), dropped };
}

function storedPlacement(slot: SlotDefinition, entry: unknown): Placement | null {
  if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.enabled !== 'boolean') {
    return null;
  }
  if (!isModuleKey(entry.module) || !slot.modules.includes(entry.module)) return null;
  const parsed = parseModuleConfig(entry.module, entry.config);
  return parsed.ok
    ? { id: entry.id, module: entry.module, enabled: entry.enabled, config: parsed.config }
    : null;
}

/** The JSON value stored in `page_versions.placements`. */
export const storedPlacements = (placements: Placements): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(placements).map(([key, list]) => [
      key,
      list.map((entry) => ({
        id: entry.id,
        module: entry.module,
        enabled: entry.enabled,
        config: entry.config,
      })),
    ]),
  );

/** The most one module's stored settings, and one version's placements, may take (JSON bytes). */
export const MAX_PLACEMENT_BYTES = 32 * 1024;
export const MAX_VERSION_BYTES = 256 * 1024;

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Size problems of a version about to be stored: each module within {@link MAX_PLACEMENT_BYTES}
 * and the whole within {@link MAX_VERSION_BYTES}, so a buyer's read of a page stays small.
 */
export function sizeProblems(placements: Placements): Problems {
  const problems: Problems = [];
  for (const [slot, list] of Object.entries(placements)) {
    list.forEach((entry, index) => {
      if (jsonBytes(entry) > MAX_PLACEMENT_BYTES) problem(problems, at(slot, index), 'too-large');
    });
  }
  if (problems.length === 0 && jsonBytes(storedPlacements(placements)) > MAX_VERSION_BYTES) {
    problem(problems, 'placements', 'too-large');
  }
  return problems;
}

export interface AddInput {
  readonly module: unknown;
  readonly config: unknown;
  /** 0-based; absent: at the end. */
  readonly position?: unknown;
  readonly enabled?: unknown;
}

/** Adds a module to a slot, at `position` or at the end. */
export function addPlacement(
  template: TemplateDefinition,
  placements: Placements,
  slotKey: string,
  input: AddInput,
  id: string,
): Change {
  const slot = editableSlot(template, slotKey);
  if (slot === null) return failed({ code: 'storefront.slot-not-found' });
  const problems: Problems = [];
  if (!isModuleKey(input.module)) {
    problem(problems, 'module', input.module === undefined ? 'required' : 'enum');
    return invalid(problems);
  }
  if (!slot.modules.includes(input.module)) {
    problem(problems, 'module', 'not-allowed-in-slot');
    return invalid(problems);
  }
  const current = placements[slotKey] ?? [];
  const position = input.position === undefined ? current.length : input.position;
  if (
    typeof position !== 'number' ||
    !Number.isInteger(position) ||
    position < 0 ||
    position > current.length
  ) {
    problem(problems, 'position', 'range');
  }
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') problem(problems, 'enabled', 'type');
  const parsed = parseModuleConfig(input.module, input.config);
  if (!parsed.ok) problems.push(...parsed.problems);
  if (problems.length > 0 || !parsed.ok) return invalid(problems);
  if (current.length >= maxOf(slot)) return failed({ code: 'storefront.slot-full' });
  const next = [...current];
  next.splice(position as number, 0, {
    id,
    module: input.module,
    enabled: enabled as boolean,
    config: parsed.config,
  });
  return done({ ...placements, [slotKey]: next });
}

/** Replaces a placement's settings, switches it on or off, or both. */
export function updatePlacement(
  template: TemplateDefinition,
  placements: Placements,
  slotKey: string,
  placementId: string,
  input: { readonly config?: unknown; readonly enabled?: unknown },
): Change {
  const slot = editableSlot(template, slotKey);
  if (slot === null) return failed({ code: 'storefront.slot-not-found' });
  const current = placements[slotKey] ?? [];
  const index = current.findIndex((entry) => entry.id === placementId);
  if (index < 0) return failed({ code: 'storefront.placement-not-found' });
  const problems: Problems = [];
  if (input.config === undefined && input.enabled === undefined) {
    problem(problems, '', 'required');
    return invalid(problems);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    problem(problems, 'enabled', 'type');
  }
  const before = current[index]!;
  let config = before.config;
  if (input.config !== undefined) {
    const parsed = parseModuleConfig(before.module, input.config);
    if (parsed.ok) config = parsed.config;
    else problems.push(...parsed.problems);
  }
  if (problems.length > 0) return invalid(problems);
  const next = [...current];
  next[index] = {
    ...before,
    config,
    enabled: input.enabled === undefined ? before.enabled : (input.enabled as boolean),
  };
  return done({ ...placements, [slotKey]: next });
}

export function removePlacement(
  template: TemplateDefinition,
  placements: Placements,
  slotKey: string,
  placementId: string,
): Change {
  if (editableSlot(template, slotKey) === null)
    return failed({ code: 'storefront.slot-not-found' });
  const current = placements[slotKey] ?? [];
  if (!current.some((entry) => entry.id === placementId)) {
    return failed({ code: 'storefront.placement-not-found' });
  }
  return done({ ...placements, [slotKey]: current.filter((entry) => entry.id !== placementId) });
}

/** Puts a slot's placements in the given order; `order` must name each of them exactly once. */
export function reorderPlacements(
  template: TemplateDefinition,
  placements: Placements,
  slotKey: string,
  order: unknown,
): Change {
  if (editableSlot(template, slotKey) === null)
    return failed({ code: 'storefront.slot-not-found' });
  const current = placements[slotKey] ?? [];
  const problems: Problems = [];
  if (
    !Array.isArray(order) ||
    order.length !== current.length ||
    order.some((id) => typeof id !== 'string') ||
    new Set(order).size !== order.length
  ) {
    problem(problems, 'placementIds', Array.isArray(order) ? 'mismatch' : 'type');
    return invalid(problems);
  }
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  const next = (order as string[]).map((id) => byId.get(id));
  if (next.some((entry) => entry === undefined)) {
    problem(problems, 'placementIds', 'mismatch');
    return invalid(problems);
  }
  return done({ ...placements, [slotKey]: next as Placement[] });
}

/**
 * What stops a version from being published: a slot under its minimum (counting the modules that
 * are switched on), or a module that needs the page's linked entity on a page that has none.
 */
export function publishProblems(
  template: TemplateDefinition,
  placements: Placements,
  linkedType: LinkedType | null,
): Problems {
  const problems: Problems = [];
  for (const slot of template.slots) {
    if (slot.kind !== 'modules') continue;
    const list = placements[slot.key] ?? [];
    if (list.filter((entry) => entry.enabled).length < slot.min) {
      problem(problems, at('slots', slot.key), 'too-few-modules');
    }
    list.forEach((entry, index) => {
      if (!entry.enabled) return;
      const source = entry.config.source as { kind?: string } | undefined;
      if (entry.module === 'product-shelf' && source?.kind === 'linked' && linkedType === null) {
        problem(problems, at(at('slots', slot.key), index), 'needs-linked-entity');
      }
      if (
        entry.module === 'product-spotlight' &&
        entry.config.productId === undefined &&
        linkedType !== 'product'
      ) {
        problem(problems, at(at('slots', slot.key), index), 'needs-linked-product');
      }
    });
  }
  return problems;
}

export interface ServedSlot {
  readonly key: string;
  readonly kind: 'modules' | 'fixed';
  readonly width: 'full' | 'column';
  readonly modules: readonly {
    readonly id: string;
    readonly module: ModuleKey;
    readonly config: ModuleConfig;
  }[];
}

/** The layout a buyer sees: every slot of the template in order, with its switched-on modules. */
export const servedSlots = (template: TemplateDefinition, placements: Placements): ServedSlot[] =>
  template.slots.map((slot) => ({
    key: slot.key,
    kind: slot.kind,
    width: slot.width,
    modules: (placements[slot.key] ?? [])
      .filter((entry) => entry.enabled)
      .map((entry) => ({ id: entry.id, module: entry.module, config: entry.config })),
  }));

/** Counts for the audit: modules in all slots. */
export const placementCount = (placements: Placements): number =>
  Object.values(placements).reduce((sum, list) => sum + list.length, 0);
