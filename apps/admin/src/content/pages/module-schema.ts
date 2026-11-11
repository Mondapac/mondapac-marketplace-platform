// The settings form of each storefront module (apps/api storefront domain/modules.ts: the closed
// catalogue). The form edits a copy of the module's settings; the API stays the judge of every
// limit, so the numbers below only size the inputs and word the hints. A setting this editor
// does not offer (the chosen categories of the category circles, the product of a spotlight, the
// ids of a manual shelf) is kept exactly as it is.

export const INFO_ICONS = ['delivery', 'tax', 'certified', 'support', 'returns', 'local'] as const;
/** v1 offers three shelf sources; another source already on a module stays and can be kept. */
export const SHELF_SOURCES_V1 = ['bestsellers', 'specials', 'linked'] as const;
export const BLOCK_TYPES = ['heading', 'paragraph', 'list'] as const;

export type FieldSpec =
  | { readonly kind: 'text'; readonly key: string; readonly max: number; readonly optional?: true }
  | { readonly kind: 'link'; readonly key: string; readonly optional?: true }
  | { readonly kind: 'image'; readonly key: string; readonly optional?: true }
  | { readonly kind: 'int'; readonly key: string; readonly min: number; readonly max: number }
  | { readonly kind: 'choice'; readonly key: string; readonly options: readonly string[] }
  | { readonly kind: 'spans'; readonly key: string; readonly optional?: true }
  | { readonly kind: 'blocks'; readonly key: string }
  | { readonly kind: 'source'; readonly key: string }
  | {
      readonly kind: 'list';
      readonly key: string;
      readonly min: number;
      readonly max: number;
      readonly item: readonly FieldSpec[];
      readonly blank: Record<string, unknown>;
    };

export const MODULE_SCHEMAS: Readonly<Record<string, readonly FieldSpec[]>> = {
  banner: [
    { kind: 'text', key: 'title', max: 80 },
    { kind: 'text', key: 'subtitle', max: 160, optional: true },
    { kind: 'image', key: 'image' },
    { kind: 'link', key: 'href', optional: true },
    { kind: 'text', key: 'ctaLabel', max: 40, optional: true },
  ],
  'category-circles': [{ kind: 'text', key: 'title', max: 80, optional: true }],
  'sellers-near-you': [
    { kind: 'text', key: 'title', max: 80, optional: true },
    { kind: 'int', key: 'limit', min: 1, max: 12 },
  ],
  'product-shelf': [
    { kind: 'text', key: 'title', max: 80, optional: true },
    { kind: 'source', key: 'source' },
    { kind: 'int', key: 'limit', min: 1, max: 24 },
  ],
  'info-strip': [
    {
      kind: 'list',
      key: 'items',
      min: 1,
      max: 4,
      blank: { icon: 'delivery' },
      item: [
        { kind: 'choice', key: 'icon', options: INFO_ICONS },
        { kind: 'text', key: 'text', max: 80, optional: true },
        { kind: 'link', key: 'href', optional: true },
      ],
    },
  ],
  'text-block': [{ kind: 'blocks', key: 'blocks' }],
  'image-text': [
    { kind: 'image', key: 'image' },
    { kind: 'text', key: 'heading', max: 120 },
    { kind: 'spans', key: 'body' },
    { kind: 'choice', key: 'imageSide', options: ['start', 'end'] },
    { kind: 'link', key: 'href', optional: true },
    { kind: 'text', key: 'ctaLabel', max: 40, optional: true },
  ],
  faq: [
    { kind: 'text', key: 'title', max: 80, optional: true },
    {
      kind: 'list',
      key: 'items',
      min: 1,
      max: 20,
      blank: { question: '', answer: [{ text: '' }] },
      item: [
        { kind: 'text', key: 'question', max: 200 },
        { kind: 'spans', key: 'answer' },
      ],
    },
  ],
  'brand-header': [
    { kind: 'text', key: 'name', max: 80 },
    { kind: 'text', key: 'description', max: 300, optional: true },
    { kind: 'image', key: 'logo', optional: true },
  ],
  'product-spotlight': [
    { kind: 'text', key: 'heading', max: 120, optional: true },
    { kind: 'spans', key: 'body', optional: true },
  ],
};

export const isEditableModule = (module: string): boolean => module in MODULE_SCHEMAS;

/** The settings a module starts with when it is added: the fields that must have a value. */
export function blankConfig(module: string): Record<string, unknown> {
  switch (module) {
    case 'sellers-near-you':
      return { limit: 8 };
    case 'product-shelf':
      return { source: { kind: 'bestsellers' }, limit: 12 };
    case 'info-strip':
      return { items: [{ icon: 'delivery' }] };
    case 'text-block':
      return { blocks: [{ type: 'paragraph', spans: [{ text: '' }] }] };
    case 'image-text':
      return { imageSide: 'start', body: [{ text: '' }] };
    case 'faq':
      return { items: [{ question: '', answer: [{ text: '' }] }] };
    default:
      return {};
  }
}

export const BLANK_BLOCKS: Readonly<Record<(typeof BLOCK_TYPES)[number], Record<string, unknown>>> =
  {
    heading: { type: 'heading', level: 2, text: '' },
    paragraph: { type: 'paragraph', spans: [{ text: '' }] },
    list: { type: 'list', items: [[{ text: '' }]] },
  };

export type Path = readonly (string | number)[];

/** The API's spelling of a path: `config.items[0].text`. */
export function pathText(path: Path): string {
  return path.reduce<string>(
    (text, part) =>
      typeof part === 'number' ? `${text}[${part}]` : text === '' ? part : `${text}.${part}`,
    '',
  );
}

export function getAt(value: unknown, path: Path): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

/** A copy of `value` with `next` at `path` (arrays and objects on the way are copied). */
export function setAt<T>(value: T, path: Path, next: unknown): T {
  const [head, ...rest] = path;
  if (head === undefined) return next as T;
  if (Array.isArray(value) || typeof head === 'number') {
    const copy = Array.isArray(value) ? [...(value as unknown[])] : [];
    copy[head as number] = setAt(copy[head as number], rest, next);
    return copy as T;
  }
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return { ...record, [head]: setAt(record[head], rest, next) } as T;
}

/**
 * What is sent: texts trimmed, no empty text, object or list, so an optional setting left blank
 * is absent. A row of a list that is left empty stays as an empty row, so the API's refusal of it
 * is drawn on the row the person sees (rows are never renumbered).
 */
export function prune(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return value.map((entry) => prune(entry) ?? (Array.isArray(entry) ? [] : {}));
  }
  if (typeof value === 'object' && value !== null) {
    const kept = Object.entries(value)
      .map(([key, entry]) => [key, prune(entry)] as const)
      .filter(([, entry]) => entry !== undefined);
    return kept.length === 0 ? undefined : Object.fromEntries(kept);
  }
  return value === null ? undefined : value;
}

export const configOf = (draft: Record<string, unknown>): Record<string, unknown> =>
  (prune(draft) as Record<string, unknown> | undefined) ?? {};

/** Two lists of the same length with the entries at `index` and `index + by` swapped. */
export function moved<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (target < 0 || target >= list.length) return [...list];
  const copy = [...list];
  const [entry] = copy.splice(index, 1);
  copy.splice(target, 0, entry as T);
  return copy;
}
