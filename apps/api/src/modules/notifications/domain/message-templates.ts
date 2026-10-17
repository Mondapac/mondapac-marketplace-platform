// The texts of every message `notifications` sends, kept as data (Phase 6 package 4). A template
// is a plain string with `{name}` slots; a value is filled in one pass, so a value that itself
// holds `{name}` is never expanded again. Texts are written per language; a Market's locale
// picks the language (exact locale, then its language part, then English), so a new language is
// a new entry here and no change to the flows. Plain text only: no template carries markup.

export type TemplateId = 'order-confirmation' | 'seller-new-order' | 'order-shipped';

export interface TemplateText {
  /** Absent for a channel without a subject. */
  readonly subject?: string;
  readonly body: string;
}

/** Keyed by language tag; `en` is the language every Market can fall back to. */
type TemplateSet = Readonly<Record<string, TemplateText>> & { readonly en: TemplateText };

const lines = (...rows: string[]): string => rows.join('\n');

const TEMPLATES: Readonly<Record<TemplateId, TemplateSet>> = {
  'order-confirmation': {
    en: {
      subject: 'Order confirmation',
      body: lines(
        'Order confirmation',
        '',
        'Thank you. Your payment was received and your order is confirmed.',
        '',
        'Order reference: {orderId}',
        '',
        'Items:',
        '{items}',
        '',
        'View your order (you will be asked to sign in):',
        '{orderUrl}',
        '',
      ),
    },
  },
  'seller-new-order': {
    en: {
      subject: 'New order',
      body: lines(
        'New order',
        '',
        'You have a new paid order to prepare.',
        '',
        'Order reference: {sellerOrderId}',
        '',
        'Items:',
        '{items}',
        '',
        'Open your seller panel to see the order and record the shipment.',
        '',
      ),
    },
  },
  'order-shipped': {
    en: {
      subject: 'Shipped',
      body: lines(
        'Shipped',
        '',
        'Good news: a seller has shipped part of your order.',
        '',
        'Order reference: {orderId}',
        'Carrier: {carrier}{tracking}',
        '',
        'View your order (you will be asked to sign in):',
        '{orderUrl}',
        '',
      ),
    },
  },
};

export interface RenderedMessage {
  readonly subject: string;
  readonly text: string;
}

/** The text for a locale: exact tag, then its language part (`en-AU` -> `en`), then English. */
export function templateFor(id: TemplateId, locale: string): TemplateText {
  const set = TEMPLATES[id];
  const own = (tag: string): TemplateText | undefined =>
    Object.hasOwn(set, tag) ? set[tag] : undefined;
  return own(locale) ?? own(locale.split('-')[0] ?? '') ?? set.en;
}

/** Fills `{name}` slots in one pass; an unknown slot stays visible so a test catches it. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (slot, key: string) => values[key] ?? slot);
}

export function renderTemplate(
  id: TemplateId,
  locale: string,
  values: Readonly<Record<string, string>>,
): RenderedMessage {
  const found = templateFor(id, locale);
  return { subject: fill(found.subject ?? '', values), text: fill(found.body, values) };
}
