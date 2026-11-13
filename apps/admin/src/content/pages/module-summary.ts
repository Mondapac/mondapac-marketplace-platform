import type { Placement } from './page-types.ts';

/** Words for the summary line; `values` fills `{name}` places. */
export type Say = (key: string, values?: Record<string, string | number>) => string;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const spansText = (value: unknown): string =>
  list(value)
    .map((span) => text(record(span).text))
    .join(' ')
    .trim();

/** The first words a text block shows: its first heading or paragraph. */
function blockText(blocks: unknown): string {
  for (const block of list(blocks)) {
    const entry = record(block);
    const found =
      entry.type === 'heading'
        ? text(entry.text)
        : entry.type === 'paragraph'
          ? spansText(entry.spans)
          : spansText(list(entry.items)[0]);
    if (found !== '') return found;
  }
  return '';
}

/** One line that tells a module apart from its neighbours in a slot. */
export function summaryOf(placement: Placement, say: Say): string {
  const config = placement.config;
  const count = list(config.items).length;
  switch (placement.module) {
    case 'banner':
      return text(config.title);
    case 'category-circles': {
      const chosen = list(config.categoryIds).length;
      return chosen > 0 ? say('summary-circles-chosen', { count: chosen }) : text(config.title);
    }
    case 'sellers-near-you':
      return say('summary-sellers', { limit: Number(config.limit ?? 8) });
    case 'product-shelf': {
      const kind = text(record(config.source).kind);
      return say('summary-shelf', {
        source: say(`source-name-${kind}`),
        limit: Number(config.limit ?? 12),
      });
    }
    case 'info-strip':
      return say('summary-strip', { count });
    case 'text-block':
      return (
        blockText(config.blocks) || say('summary-blocks', { count: list(config.blocks).length })
      );
    case 'image-text':
      return text(config.heading);
    case 'faq':
      return text(config.title) || say('summary-faq', { count });
    case 'brand-header':
      return text(config.name);
    case 'product-spotlight':
      return text(config.heading) || say('summary-spotlight');
    default:
      return '';
  }
}
