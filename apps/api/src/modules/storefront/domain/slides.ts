import { Temporal } from '@mondapac/shared-kernel';
import {
  at,
  closedObject,
  code,
  image,
  isRecord,
  list,
  oneOf,
  problem,
  text,
  uuid,
  wholeNumber,
  type Problems,
} from './fields';
import { positionOf, SLIDE_SCOPES, type SlideScope } from './slide-positions';

// The slide library (john, 23 Oct): a slide is plain text over an optional image, with one typed
// internal link that makes the whole slide clickable. Content is data: no markup, no URL, no
// external link. All checks push `{ path, code }` onto the problems of the input.

export const SLIDE_KINDS = ['announcement', 'promotion', 'link'] as const;
export type SlideKind = (typeof SLIDE_KINDS)[number];

export const LINK_TYPES = ['category', 'product', 'seller', 'page', 'search'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
export const TEXT_POSITIONS = ['start', 'center', 'end'] as const;
export const TEXT_TONES = ['light', 'dark'] as const;

export const TITLE_MAX = 60;
export const BODY_MAX = 160;
export const CTA_MAX = 24;
export const NAME_MAX = 80;
export const MAX_PLACEMENTS = 10;
/** A slide runs for at most 90 days: 2160 hours, in absolute time (no daylight-saving drift). */
export const MAX_WINDOW_HOURS = 90 * 24;
export const MAX_VERSIONS_PER_SLIDE = 100;
/** Most slides one reorder names: the live placements of one position and scope. */
export const MAX_REORDER_SLIDES = 100;

export interface SlideLink {
  readonly type: LinkType;
  readonly id: string;
}

export interface SlideImage {
  readonly ref: string;
  /** Empty only when `decorative`: the text carries the message. */
  readonly alt: string;
  readonly decorative: boolean;
}

export interface SlideContent {
  readonly title: string;
  readonly body: string | null;
  readonly ctaLabel: string | null;
  readonly image: SlideImage | null;
  readonly textPosition: (typeof TEXT_POSITIONS)[number];
  readonly textTone: (typeof TEXT_TONES)[number];
  readonly link: SlideLink | null;
}

export interface SlidePlacement {
  readonly position: string;
  readonly scope: SlideScope;
  readonly scopeId: string | null;
  readonly includeSubcategories: boolean;
  readonly sortOrder: number;
  readonly autoplay: boolean;
}

export interface SlideWindow {
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
}

/** What a draft version holds and what create and update accept (the kind is the slide's own). */
export interface SlideDraftInput extends SlideWindow {
  readonly internalName: string;
  readonly content: SlideContent;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly placements: readonly SlidePlacement[];
}

export interface NewSlideInput extends SlideDraftInput {
  readonly kind: SlideKind;
}

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: Problems };

const MARKUP = /[<>]/u;
// Top-level domains a bare host such as `halal-deals.com/x` can end in. A list, not "any word
// after a dot", so "e.g.", "2.5" and "Sale.Ends today" are not mistaken for a host.
const TLDS =
  'com|net|org|info|biz|edu|gov|io|ai|app|dev|xyz|shop|store|online|site|website|link|click|club|' +
  'vip|tv|cc|ly|ws|fm|au|nz|my|sg|uk|eu|fr|nl|ru|cn|jp|br|za|ae|pk|bd';
const URL_LIKE = new RegExp(
  [
    '[a-z][a-z0-9+.-]*:\\/\\/', // a scheme
    '\\bwww\\.',
    '\\bmailto:',
    '\\bjavascript:',
    '[\\p{L}\\p{N}._-]+@[\\p{L}\\p{N}-]+\\.[\\p{L}]{2,}', // an address
    '\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b', // an IPv4 address
    `(?<![\\p{L}\\p{N}@])(?:[\\p{L}\\p{N}-]+\\.)+(?:${TLDS})(?![\\p{L}\\p{N}])`, // a bare host
  ].join('|'),
  'iu',
);

/** A plain text: no markup characters and no URL-like text. */
function plain(
  problems: Problems,
  path: string,
  value: unknown,
  max: number,
  optional: boolean,
): string | null {
  const checked = text(problems, path, value, max, optional);
  if (checked === null) return null;
  if (MARKUP.test(checked)) {
    problem(problems, path, 'markup');
    return null;
  }
  if (URL_LIKE.test(checked)) {
    problem(problems, path, 'url');
    return null;
  }
  return checked;
}

/** A typed internal link; never a URL. A prepared search is named by its code, the rest by id. */
function parseLink(problems: Problems, path: string, value: unknown): SlideLink | null {
  if (!closedObject(problems, path, value, ['type', 'id'])) return null;
  const type = oneOf(problems, at(path, 'type'), value.type, LINK_TYPES);
  if (type === null) return null;
  const id =
    type === 'search'
      ? code(problems, at(path, 'id'), value.id)
      : uuid(problems, at(path, 'id'), value.id);
  return id === null ? null : { type, id };
}

function parseImage(problems: Problems, path: string, value: unknown): SlideImage | null {
  if (!closedObject(problems, path, value, ['ref', 'alt', 'decorative'])) return null;
  const decorative = value.decorative ?? false;
  if (typeof decorative !== 'boolean') {
    problem(problems, at(path, 'decorative'), 'type');
    return null;
  }
  if (!decorative) {
    // A content image carries alt text (the shared check requires it).
    const checked = image(problems, path, { ref: value.ref, alt: value.alt });
    if (checked === null) return null;
    // Alt text is plain text too: no markup, no URL.
    const alt = plain(problems, at(path, 'alt'), checked.alt, 160, false);
    return alt === null ? null : { ref: checked.ref, alt, decorative: false };
  }
  // Decorative: the text carries the message, so the alt text must be empty.
  const probe: Problems = [];
  const checked = image(probe, path, { ref: value.ref, alt: 'x' });
  for (const entry of probe) problems.push(entry);
  if (value.alt !== undefined && value.alt !== '') problem(problems, at(path, 'alt'), 'not-empty');
  return checked === null || (value.alt !== undefined && value.alt !== '')
    ? null
    : { ref: checked.ref, alt: '', decorative: true };
}

export function parseContent(
  problems: Problems,
  path: string,
  kind: SlideKind,
  value: unknown,
): SlideContent | null {
  const before = problems.length;
  if (
    !closedObject(problems, path, value, [
      'title',
      'body',
      'ctaLabel',
      'image',
      'textPosition',
      'textTone',
      'link',
    ])
  ) {
    return null;
  }
  const title = plain(problems, at(path, 'title'), value.title, TITLE_MAX, false);
  const body = plain(problems, at(path, 'body'), value.body, BODY_MAX, true);
  const ctaLabel = plain(problems, at(path, 'ctaLabel'), value.ctaLabel, CTA_MAX, true);
  const slideImage =
    value.image === undefined || value.image === null
      ? null
      : parseImage(problems, at(path, 'image'), value.image);
  const textPosition =
    value.textPosition === undefined
      ? 'start'
      : oneOf(problems, at(path, 'textPosition'), value.textPosition, TEXT_POSITIONS);
  const textTone =
    value.textTone === undefined
      ? 'light'
      : oneOf(problems, at(path, 'textTone'), value.textTone, TEXT_TONES);
  let link: SlideLink | null = null;
  if (value.link === undefined || value.link === null) {
    if (kind === 'link') problem(problems, at(path, 'link'), 'required');
  } else {
    link = parseLink(problems, at(path, 'link'), value.link);
  }
  if (ctaLabel !== null && link === null && problems.length === before) {
    // A button label with nothing to open.
    problem(problems, at(path, 'ctaLabel'), 'needs-link');
  }
  if (problems.length > before || title === null || textPosition === null || textTone === null) {
    return null;
  }
  return { title, body, ctaLabel, image: slideImage, textPosition, textTone, link };
}

export function parsePlacements(
  problems: Problems,
  path: string,
  value: unknown,
): SlidePlacement[] | null {
  const seen = new Set<string>();
  return list(problems, path, value, 1, MAX_PLACEMENTS, (itemPath, entry) => {
    const before = problems.length;
    if (
      !closedObject(problems, itemPath, entry, [
        'position',
        'scope',
        'scopeId',
        'includeSubcategories',
        'sortOrder',
        'autoplay',
      ])
    ) {
      return null;
    }
    const positionKey = typeof entry.position === 'string' ? entry.position : null;
    const position = positionKey === null ? null : positionOf(positionKey);
    if (position === null) problem(problems, at(itemPath, 'position'), 'enum');
    const scope = oneOf(problems, at(itemPath, 'scope'), entry.scope ?? 'all', SLIDE_SCOPES);
    let scopeId: string | null = null;
    if (scope !== null && scope !== 'all')
      scopeId = uuid(problems, at(itemPath, 'scopeId'), entry.scopeId);
    else if (entry.scopeId !== undefined && entry.scopeId !== null) {
      problem(problems, at(itemPath, 'scopeId'), 'not-allowed');
    }
    if (position !== null && scope !== null && !position.scopes.includes(scope)) {
      problem(problems, at(itemPath, 'scope'), 'not-allowed-here');
    }
    const includeSubcategories = entry.includeSubcategories ?? false;
    if (typeof includeSubcategories !== 'boolean') {
      problem(problems, at(itemPath, 'includeSubcategories'), 'type');
    } else if (includeSubcategories && scope !== 'category') {
      problem(problems, at(itemPath, 'includeSubcategories'), 'not-allowed');
    }
    const sortOrder =
      entry.sortOrder === undefined
        ? 0
        : wholeNumber(problems, at(itemPath, 'sortOrder'), entry.sortOrder, 0, 1000);
    const autoplay = entry.autoplay ?? false;
    if (typeof autoplay !== 'boolean') problem(problems, at(itemPath, 'autoplay'), 'type');
    else if (autoplay && position !== null && !position.autoplay) {
      // Autoplay only at the hero and the top of a landing page (john, decision 3).
      problem(problems, at(itemPath, 'autoplay'), 'not-allowed-here');
    }
    const key = `${positionKey}|${scope}|${scopeId}`;
    if (seen.has(key)) problem(problems, itemPath, 'duplicate');
    seen.add(key);
    if (
      problems.length > before ||
      position === null ||
      scope === null ||
      sortOrder === null ||
      typeof includeSubcategories !== 'boolean' ||
      typeof autoplay !== 'boolean'
    ) {
      return null;
    }
    return {
      position: position.key,
      scope,
      scopeId,
      includeSubcategories,
      sortOrder,
      autoplay,
    };
  });
}

/** An ISO instant with an offset or `Z`; the window is stored as instants (ADR-0005). */
function instant(problems: Problems, path: string, value: unknown): Temporal.Instant | null {
  if (typeof value !== 'string') {
    problem(problems, path, value === undefined ? 'required' : 'type');
    return null;
  }
  try {
    return Temporal.Instant.from(value);
  } catch {
    problem(problems, path, 'format');
    return null;
  }
}

/** The 90-day rule: the end is after the start and at most 2160 hours later. */
export function windowProblems(window: SlideWindow): Problems {
  const problems: Problems = [];
  if (Temporal.Instant.compare(window.endsAt, window.startsAt) <= 0) {
    problem(problems, 'endsAt', 'before-start');
  } else if (
    Temporal.Instant.compare(window.endsAt, window.startsAt.add({ hours: MAX_WINDOW_HOURS })) > 0
  ) {
    problem(problems, 'endsAt', 'too-long');
  }
  return problems;
}

const DRAFT_FIELDS = [
  'internalName',
  'content',
  'startsAt',
  'endsAt',
  'pinned',
  'sponsored',
  'placements',
] as const;

export function parseDraft(
  kind: SlideKind,
  body: unknown,
  extra: readonly string[] = [],
): Parsed<SlideDraftInput> {
  const problems: Problems = [];
  if (!closedObject(problems, '', body, [...DRAFT_FIELDS, ...extra]))
    return { ok: false, problems };
  const internalName = plain(problems, 'internalName', body.internalName, NAME_MAX, false);
  const content = parseContent(problems, 'content', kind, body.content);
  const startsAt = instant(problems, 'startsAt', body.startsAt);
  const endsAt = instant(problems, 'endsAt', body.endsAt);
  const flag = (key: 'pinned' | 'sponsored'): boolean => {
    const raw = body[key] ?? false;
    if (typeof raw !== 'boolean') problem(problems, key, 'type');
    return raw === true;
  };
  const pinned = flag('pinned');
  const sponsored = flag('sponsored');
  const placements = parsePlacements(problems, 'placements', body.placements);
  if (startsAt !== null && endsAt !== null) {
    for (const entry of windowProblems({ startsAt, endsAt })) problems.push(entry);
  }
  if (
    problems.length > 0 ||
    internalName === null ||
    content === null ||
    startsAt === null ||
    endsAt === null ||
    placements === null
  ) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    value: { internalName, content, startsAt, endsAt, pinned, sponsored, placements },
  };
}

export function parseNewSlide(body: unknown): Parsed<NewSlideInput> {
  const problems: Problems = [];
  if (!isRecord(body)) {
    problem(problems, '', 'type');
    return { ok: false, problems };
  }
  const kind = oneOf(problems, 'kind', body.kind, SLIDE_KINDS);
  if (kind === null) return { ok: false, problems };
  const draft = parseDraft(kind, body, ['kind']);
  return draft.ok ? { ok: true, value: { kind, ...draft.value } } : draft;
}

/** The stored forms (jsonb) of a version's content and placements. */
export const storedContent = (content: SlideContent): Record<string, unknown> =>
  // An absent optional field is left out, not stored as null (the CHECKs read an absent key).
  Object.fromEntries(Object.entries(content).filter(([, value]) => value !== null));
export const storedPlacements = (placements: readonly SlidePlacement[]): unknown[] =>
  placements.map((placement) => ({ ...placement }));

/** Reads stored content back through the same checks; a row that no longer passes is not served. */
export function readContent(kind: SlideKind, stored: unknown): SlideContent | null {
  const problems: Problems = [];
  const content = parseContent(problems, 'content', kind, stored);
  return problems.length === 0 ? content : null;
}

export function readPlacements(stored: unknown): SlidePlacement[] {
  const problems: Problems = [];
  const placements = parsePlacements(problems, 'placements', stored);
  return problems.length === 0 && placements !== null ? placements : [];
}

// ---- state --------------------------------------------------------------------------------

export type StoredSlideState = 'draft' | 'approved' | 'paused' | 'archived';
export type SlideStatus =
  'draft' | 'pending' | 'scheduled' | 'live' | 'ended' | 'paused' | 'archived';

export interface StateFacts {
  readonly state: StoredSlideState;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly draftVersionId: string | null;
  readonly submittedVersionId: string | null;
}

/** The status the admin sees: scheduled, live and ended follow from the window and the clock. */
export function statusOf(facts: StateFacts, now: Temporal.Instant): SlideStatus {
  if (facts.state === 'archived') return 'archived';
  if (facts.state === 'paused') return 'paused';
  if (facts.state === 'draft') {
    return facts.draftVersionId !== null && facts.draftVersionId === facts.submittedVersionId
      ? 'pending'
      : 'draft';
  }
  if (Temporal.Instant.compare(now, facts.startsAt) < 0) return 'scheduled';
  if (Temporal.Instant.compare(now, facts.endsAt) >= 0) return 'ended';
  return 'live';
}

export const isPending = (facts: StateFacts): boolean =>
  facts.draftVersionId !== null && facts.draftVersionId === facts.submittedVersionId;

// ---- caps ---------------------------------------------------------------------------------

export interface PlacedSlide extends SlideWindow {
  readonly slideId: string;
  readonly scope: SlideScope;
  readonly scopeId: string | null;
  readonly includeSubcategories: boolean;
}

/**
 * Whether two placements of one position can show on the same page. Without the category tree
 * the check is conservative: all meets everything; two scopes of one type meet only when they
 * name the same id (a category with subcategories meets any category); different types meet.
 */
export function scopesMeet(
  a: Pick<PlacedSlide, 'scope' | 'scopeId' | 'includeSubcategories'>,
  b: Pick<PlacedSlide, 'scope' | 'scopeId' | 'includeSubcategories'>,
): boolean {
  if (a.scope === 'all' || b.scope === 'all') return true;
  if (a.scope !== b.scope) return true;
  if (a.scope === 'category' && (a.includeSubcategories || b.includeSubcategories)) return true;
  return a.scopeId === b.scopeId;
}

/**
 * Whether adding `candidate` to the slides already placed at one position would put more than
 * `max` slides on one page at some instant of the candidate's window. The instants checked are
 * the candidate's start and every start inside its window (the count only grows at a start).
 */
export function capExceeded(
  candidate: PlacedSlide,
  existing: readonly PlacedSlide[],
  max: number,
): boolean {
  const meeting = existing.filter(
    (other) =>
      other.slideId !== candidate.slideId &&
      scopesMeet(candidate, other) &&
      Temporal.Instant.compare(other.startsAt, candidate.endsAt) < 0 &&
      Temporal.Instant.compare(other.endsAt, candidate.startsAt) > 0,
  );
  const instants = [candidate.startsAt, ...meeting.map((other) => other.startsAt)].filter(
    (t) =>
      Temporal.Instant.compare(t, candidate.startsAt) >= 0 &&
      Temporal.Instant.compare(t, candidate.endsAt) < 0,
  );
  return instants.some(
    (t) =>
      meeting.filter(
        (other) =>
          Temporal.Instant.compare(other.startsAt, t) <= 0 &&
          Temporal.Instant.compare(other.endsAt, t) > 0,
      ).length +
        1 >
      max,
  );
}

// ---- order of the live slides ---------------------------------------------------------------

/** Where and in which order: the whole list of the live slides of one position and scope. */
export interface ReorderInput {
  readonly position: string;
  readonly scope: SlideScope;
  readonly scopeId: string | null;
  /** Ids as the store writes them (lower case), first shown first. */
  readonly slideIds: readonly string[];
}

export function parseReorder(body: unknown): Parsed<ReorderInput> {
  const problems: Problems = [];
  if (!closedObject(problems, '', body, ['position', 'scope', 'scopeId', 'slideIds'])) {
    return { ok: false, problems };
  }
  const positionKey = typeof body.position === 'string' ? body.position : null;
  const position = positionKey === null ? null : positionOf(positionKey);
  if (position === null)
    problem(problems, 'position', body.position === undefined ? 'required' : 'enum');
  const scope = oneOf(problems, 'scope', body.scope ?? 'all', SLIDE_SCOPES);
  let scopeId: string | null = null;
  if (scope !== null && scope !== 'all') {
    scopeId = uuid(problems, 'scopeId', body.scopeId);
  } else if (body.scopeId !== undefined && body.scopeId !== null) {
    problem(problems, 'scopeId', 'not-allowed');
  }
  if (position !== null && scope !== null && !position.scopes.includes(scope)) {
    problem(problems, 'scope', 'not-allowed-here');
  }
  const seen = new Set<string>();
  const slideIds = list(
    problems,
    'slideIds',
    body.slideIds,
    1,
    MAX_REORDER_SLIDES,
    (path, entry) => {
      const id = uuid(problems, path, entry);
      if (id === null) return null;
      if (seen.has(id)) {
        problem(problems, path, 'duplicate');
        return null;
      }
      seen.add(id);
      return id;
    },
  );
  if (problems.length > 0 || position === null || scope === null || slideIds === null) {
    return { ok: false, problems };
  }
  return { ok: true, value: { position: position.key, scope, scopeId, slideIds } };
}

/**
 * Whether the requested order names exactly the live slides of the position and scope: every
 * live one, none else. A slide that is not live there (paused, a draft, ended, at another
 * position or scope) and a live one left out are both named.
 */
export function reorderMismatch(requested: readonly string[], live: readonly string[]): Problems {
  const problems: Problems = [];
  const liveSet = new Set(live);
  for (const [index, id] of requested.entries()) {
    if (!liveSet.has(id)) problem(problems, `slideIds[${index}]`, 'not-live-here');
  }
  const wanted = new Set(requested);
  if (live.some((id) => !wanted.has(id))) problem(problems, 'slideIds', 'incomplete');
  return problems;
}

/** The key under which a slide's saved live order is kept: one per position, scope and scope id. */
export const orderKey = (placement: {
  readonly position: string;
  readonly scope: string;
  readonly scopeId: string | null;
}): string => `${placement.position}|${placement.scope}|${placement.scopeId ?? ''}`;
