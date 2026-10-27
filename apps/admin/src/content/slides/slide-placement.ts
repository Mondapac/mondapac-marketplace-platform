import { carriedOf, formOf, requestOf, type Carried } from './slide-form.ts';
import {
  MAX_WINDOW_DAYS,
  SLIDE_POSITIONS,
  type SlideDetail,
  type SlidePlacement,
  type SlideScope,
  type SlideSummary,
} from './slide-types.ts';
import { instantToLocal, localToInstant } from './zone-time.ts';

// The "Where and when" tab as form state, the whole-draft request it makes and the checks that run
// before a request is sent. The API checks the same things (`placements`, `startsAt`, `endsAt`)
// and answers `validation.failed` with `details.fields`; those paths are mapped back onto rows.

/** One position of the catalogue: chosen or not, and where on its pages. */
export interface RowState {
  readonly on: boolean;
  readonly scope: SlideScope;
  readonly scopeId: string;
  readonly includeSubcategories: boolean;
  /** Kept from the saved placement, so a save does not reshuffle the position. */
  readonly sortOrder: number;
  readonly autoplay: boolean;
  /** Other saved placements at the same position (another scope); a save sends them again. */
  readonly extra: readonly SlidePlacement[];
}

export interface PlacementFormState {
  readonly rows: Readonly<Record<string, RowState>>;
  /** Placements at a position this panel does not know; a save sends them again. */
  readonly others: readonly SlidePlacement[];
  /** `datetime-local` values on the clock of the Market's zone. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly pinned: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const emptyRow = (autoplay: boolean): RowState => ({
  on: false,
  scope: 'all',
  scopeId: '',
  includeSubcategories: false,
  sortOrder: 0,
  autoplay,
  extra: [],
});

export function placementFormOf(slide: SlideDetail, zone: string): PlacementFormState {
  const carried = carriedOf(slide);
  const placements = carried?.placements ?? [];
  const rows: Record<string, RowState> = {};
  for (const position of SLIDE_POSITIONS) {
    const here = placements.filter((placement) => placement.position === position.key);
    const [first, ...extra] = here;
    rows[position.key] =
      first === undefined
        ? emptyRow(position.autoplay)
        : {
            on: true,
            scope: first.scope,
            scopeId: first.scopeId ?? '',
            includeSubcategories: first.includeSubcategories,
            sortOrder: first.sortOrder,
            autoplay: first.autoplay,
            extra,
          };
  }
  return {
    rows,
    others: placements.filter(
      (placement) => !SLIDE_POSITIONS.some((position) => position.key === placement.position),
    ),
    startsAt: instantToLocal(carried?.startsAt ?? '', zone),
    endsAt: instantToLocal(carried?.endsAt ?? '', zone),
    pinned: carried?.pinned ?? false,
  };
}

export const samePlacementForm = (a: PlacementFormState, b: PlacementFormState): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The placements to save, in the catalogue's order, and the position of each (for field errors). */
export function placementsOf(form: PlacementFormState): {
  readonly placements: SlidePlacement[];
  readonly keys: string[];
} {
  const placements: SlidePlacement[] = [];
  const keys: string[] = [];
  for (const position of SLIDE_POSITIONS) {
    const row = form.rows[position.key];
    if (row === undefined || !row.on) continue;
    placements.push({
      position: position.key,
      scope: row.scope,
      scopeId: row.scope === 'all' ? null : row.scopeId.trim(),
      includeSubcategories: row.scope === 'category' && row.includeSubcategories,
      sortOrder: row.sortOrder,
      autoplay: row.autoplay,
    });
    keys.push(position.key);
    for (const extra of row.extra) {
      placements.push(extra);
      keys.push('');
    }
  }
  for (const other of form.others) {
    placements.push(other);
    keys.push('');
  }
  return { placements, keys };
}

export type WindowCode = 'required' | 'format' | 'before-start' | 'too-long';
export type RowCode = 'required' | 'format' | 'invalid';

export interface PlacementErrors {
  readonly startsAt?: WindowCode;
  readonly endsAt?: WindowCode;
  /** Nothing is chosen. */
  readonly none?: true;
  readonly rows: Readonly<Record<string, { scopeId?: RowCode; scope?: RowCode }>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The errors left once a field (a window field, or a row) is edited; "choose a position" goes too. */
export function clearErrors(
  errors: PlacementErrors,
  edited: { readonly field?: 'startsAt' | 'endsAt'; readonly row?: string },
): PlacementErrors {
  const rows = { ...errors.rows };
  if (edited.row !== undefined) delete rows[edited.row];
  return {
    ...(errors.startsAt === undefined || edited.field === 'startsAt'
      ? {}
      : { startsAt: errors.startsAt }),
    ...(errors.endsAt === undefined || edited.field === 'endsAt' ? {} : { endsAt: errors.endsAt }),
    ...(edited.row === undefined && errors.none === true ? { none: true as const } : {}),
    rows,
  };
}

export const hasErrors = (errors: PlacementErrors): boolean =>
  errors.startsAt !== undefined ||
  errors.endsAt !== undefined ||
  errors.none === true ||
  Object.keys(errors.rows).length > 0;

/** The window as the API reads it: absolute time, so 90 days are 2160 hours in any zone. */
export function windowError(
  startIso: string | null,
  endIso: string | null,
  startRaw: string,
  endRaw: string,
): Pick<PlacementErrors, 'startsAt' | 'endsAt'> {
  const out: { startsAt?: WindowCode; endsAt?: WindowCode } = {};
  if (startRaw === '') out.startsAt = 'required';
  else if (startIso === null) out.startsAt = 'format';
  if (endRaw === '') out.endsAt = 'required';
  else if (endIso === null) out.endsAt = 'format';
  if (out.startsAt === undefined && out.endsAt === undefined && startIso && endIso) {
    const span = Date.parse(endIso) - Date.parse(startIso);
    if (span <= 0) out.endsAt = 'before-start';
    else if (span > MAX_WINDOW_DAYS * MS_PER_DAY) out.endsAt = 'too-long';
  }
  return out;
}

export function validatePlacement(form: PlacementFormState, zone: string): PlacementErrors {
  const rows: Record<string, { scopeId?: RowCode }> = {};
  let chosen = 0;
  for (const position of SLIDE_POSITIONS) {
    const row = form.rows[position.key];
    if (row === undefined || !row.on) continue;
    chosen += 1;
    if (row.scope !== 'all') {
      const id = row.scopeId.trim();
      if (id === '') rows[position.key] = { scopeId: 'required' };
      else if (!UUID.test(id)) rows[position.key] = { scopeId: 'format' };
    }
  }
  const startIso = localToInstant(form.startsAt, zone);
  const endIso = localToInstant(form.endsAt, zone);
  return {
    ...windowError(startIso, endIso, form.startsAt, form.endsAt),
    ...(chosen === 0 && form.others.length === 0 ? { none: true as const } : {}),
    rows,
  };
}

/** The whole draft again, with the new positions, window and pin; the content is as saved. */
export function placementRequestOf(
  slide: SlideDetail,
  form: PlacementFormState,
  zone: string,
): ReturnType<typeof requestOf> | null {
  const carried = carriedOf(slide);
  if (carried === null) return null;
  // A time the person did not touch is sent as saved (it may carry seconds the field cannot).
  const instant = (local: string, saved: string): string | null =>
    local === instantToLocal(saved, zone) ? saved : localToInstant(local, zone);
  const startsAt = instant(form.startsAt, carried.startsAt);
  const endsAt = instant(form.endsAt, carried.endsAt);
  if (startsAt === null || endsAt === null) return null;
  const next: Carried = {
    ...carried,
    startsAt,
    endsAt,
    pinned: form.pinned,
    placements: placementsOf(form).placements,
  };
  return requestOf(formOf(slide), next, false);
}

export interface PlacementProblems {
  readonly errors: PlacementErrors;
  /** Problems of values this tab does not edit, or unknown ones. */
  readonly other: number;
}

/** Puts the `details.fields` of a `validation.failed` answer onto the rows and the window. */
export function mapPlacementProblems(
  problems: readonly { readonly path: string; readonly code: string }[],
  keys: readonly string[],
): PlacementProblems {
  const rows: Record<string, { scopeId?: RowCode; scope?: RowCode }> = {};
  let startsAt: WindowCode | undefined;
  let endsAt: WindowCode | undefined;
  let none = false;
  let other = 0;
  const windowCode = (code: string): WindowCode =>
    code === 'required' || code === 'before-start' || code === 'too-long' ? code : 'format';
  for (const problem of problems) {
    if (problem.path === 'startsAt') startsAt ??= windowCode(problem.code);
    else if (problem.path === 'endsAt') endsAt ??= windowCode(problem.code);
    else if (problem.path === 'placements') none = true;
    else {
      const match = /^placements\[(\d+)\]\.?(scopeId|scope)?$/u.exec(problem.path);
      const key = match === null ? undefined : keys[Number(match[1])];
      if (key === undefined || key === '' || match === null) {
        other += 1;
      } else {
        const field = match[2] === 'scope' ? 'scope' : 'scopeId';
        const code: RowCode =
          problem.code === 'required'
            ? 'required'
            : problem.code === 'format'
              ? 'format'
              : 'invalid';
        rows[key] = { ...rows[key], [field]: rows[key]?.[field] ?? code };
      }
    }
  }
  return {
    errors: {
      ...(startsAt === undefined ? {} : { startsAt }),
      ...(endsAt === undefined ? {} : { endsAt }),
      ...(none ? { none: true as const } : {}),
      rows,
    },
    other,
  };
}

/**
 * How many slides are live now at each position, from the list of live slides. This slide is left
 * out, so a position is "full" for it when the others already fill every place. The list names the
 * positions of a slide's current version (its draft when it has one), so this is a close reading,
 * not the API's own count, which is checked again when a platform admin approves.
 */
export function liveCounts(
  slides: readonly SlideSummary[],
  selfId: string,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const position of SLIDE_POSITIONS) counts[position.key] = 0;
  for (const slide of slides) {
    if (slide.status !== 'live' || slide.id === selfId) continue;
    for (const key of new Set(slide.positions)) {
      if (key in counts) counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}
