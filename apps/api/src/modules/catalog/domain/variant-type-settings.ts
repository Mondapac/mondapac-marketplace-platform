import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import type { LocalizedText } from './attribute-definition';

// How buyers choose a variant type (variants V6; plan section 9, decision tn1). A variant type is
// an attribute definition with `isVariantOption`; its name, its options and their labels stay in
// Attributes (one place to edit them). These settings say only how the options are shown: the
// display style, the order, a swatch colour per option and one help sentence for sellers.

/** How the buyer picker shows a variant type's options. */
export const VARIANT_DISPLAY_STYLES = ['buttons', 'swatches', 'dropdown'] as const;
export type VariantDisplayStyle = (typeof VARIANT_DISPLAY_STYLES)[number];

/**
 * The order of the options: `manual` is the position set in Attributes; `alphabetical` sorts the
 * labels of the shown locale; `by-size` sorts by the amount a label starts with ("250 g" before
 * "1 kg"), converting units of one kind, and puts labels without an amount last, in manual order.
 */
export const VARIANT_OPTION_ORDERS = ['manual', 'alphabetical', 'by-size'] as const;
export type VariantOptionOrder = (typeof VARIANT_OPTION_ORDERS)[number];

/** The most swatch colours one variant type holds: its options (`ATTRIBUTE_OPTIONS_MAX`). */
export const SWATCHES_MAX = 200;
/** One sentence above the variant grid. */
export const SELLER_HELP_MAX = 200;

const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/;
const COLOUR = /^#[0-9A-F]{6}$/;
const OPTION_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface VariantTypeSettingsContent {
  readonly displayStyle: VariantDisplayStyle;
  readonly optionOrder: VariantOptionOrder;
  /** Option code to colour `#RRGGBB` (upper case). An option without one shows its label. */
  readonly swatches: { readonly [optionCode: string]: string };
  /** Locale to one plain sentence sellers see above the variant grid. */
  readonly sellerHelp: LocalizedText;
}

/** What a variant type without stored settings uses. */
export const DEFAULT_VARIANT_TYPE_SETTINGS: VariantTypeSettingsContent = Object.freeze({
  displayStyle: 'buttons',
  optionOrder: 'manual',
  swatches: Object.freeze({}),
  sellerHelp: Object.freeze({}),
});

export interface VariantTypeSettingsState extends VariantTypeSettingsContent {
  readonly marketId: MarketId;
  readonly definitionId: Id<'AttributeDefinition'>;
  readonly revisionId: Id<'VariantTypeSettingRevision'>;
  readonly revisionNo: number;
  /** 1 for the first stored settings; a write names the version it read (0: none stored). */
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  readonly revisedAt: Temporal.Instant;
}

export type VariantTypeSettingsRefusal =
  | { readonly code: 'variant-type.display-style-invalid' }
  | { readonly code: 'variant-type.option-order-invalid' }
  | { readonly code: 'variant-type.swatch-invalid'; readonly option: string }
  | { readonly code: 'variant-type.swatch-unknown-option'; readonly option: string }
  | { readonly code: 'variant-type.swatches-too-many' }
  | { readonly code: 'variant-type.help-invalid'; readonly locale: string }
  | { readonly code: 'variant-type.locale-invalid'; readonly locale: string };

/**
 * Checks content against the variant type's option codes (every option the published revision
 * holds, active or not, so a deactivated option keeps its colour) and the Market's locales.
 */
export function checkVariantTypeSettings(
  content: VariantTypeSettingsContent,
  optionCodes: ReadonlySet<string>,
  locales: readonly string[],
): VariantTypeSettingsRefusal | null {
  if (!(VARIANT_DISPLAY_STYLES as readonly string[]).includes(content.displayStyle)) {
    return { code: 'variant-type.display-style-invalid' };
  }
  if (!(VARIANT_OPTION_ORDERS as readonly string[]).includes(content.optionOrder)) {
    return { code: 'variant-type.option-order-invalid' };
  }
  const swatches = Object.entries(content.swatches);
  if (swatches.length > SWATCHES_MAX) return { code: 'variant-type.swatches-too-many' };
  for (const [option, colour] of swatches) {
    if (!OPTION_CODE.test(option) || !optionCodes.has(option)) {
      return { code: 'variant-type.swatch-unknown-option', option: option.slice(0, 64) };
    }
    if (typeof colour !== 'string' || !COLOUR.test(colour)) {
      return { code: 'variant-type.swatch-invalid', option };
    }
  }
  for (const [locale, text] of Object.entries(content.sellerHelp)) {
    if (!LOCALE.test(locale) || !locales.includes(locale)) {
      return { code: 'variant-type.locale-invalid', locale: locale.slice(0, 16) };
    }
    const length = [...text].length;
    if (
      typeof text !== 'string' ||
      text !== text.trim() ||
      length < 1 ||
      length > SELLER_HELP_MAX ||
      !parsePlainText(text).ok
    ) {
      return { code: 'variant-type.help-invalid', locale };
    }
  }
  return null;
}

/** A colour as typed (`#a1b2c3`, `A1B2C3`) in the stored form `#A1B2C3`, or null. */
export function normaliseColour(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(text) ? `#${text}` : null;
}

/** The variant type's settings: the stored revision, or the defaults until one is saved. */
export class VariantTypeSettings {
  private constructor(readonly state: VariantTypeSettingsState) {}

  static rehydrate(state: VariantTypeSettingsState): VariantTypeSettings {
    return new VariantTypeSettings(state);
  }

  /** The first stored settings of a variant type (version 1, revision 1). */
  static create(input: {
    readonly marketId: MarketId;
    readonly definitionId: Id<'AttributeDefinition'>;
    readonly revisionId: Id<'VariantTypeSettingRevision'>;
    readonly content: VariantTypeSettingsContent;
    readonly optionCodes: ReadonlySet<string>;
    readonly locales: readonly string[];
    readonly now: Temporal.Instant;
  }): Result<VariantTypeSettings, VariantTypeSettingsRefusal> {
    const refusal = checkVariantTypeSettings(input.content, input.optionCodes, input.locales);
    if (refusal !== null) return err(refusal);
    return ok(
      new VariantTypeSettings({
        ...copyOf(input.content),
        marketId: input.marketId,
        definitionId: input.definitionId,
        revisionId: input.revisionId,
        revisionNo: 1,
        version: 1,
        createdAt: input.now,
        revisedAt: input.now,
      }),
    );
  }

  /** The next revision with the whole new content. */
  revise(input: {
    readonly revisionId: Id<'VariantTypeSettingRevision'>;
    readonly content: VariantTypeSettingsContent;
    readonly optionCodes: ReadonlySet<string>;
    readonly locales: readonly string[];
    readonly now: Temporal.Instant;
  }): Result<VariantTypeSettings, VariantTypeSettingsRefusal> {
    const refusal = checkVariantTypeSettings(input.content, input.optionCodes, input.locales);
    if (refusal !== null) return err(refusal);
    return ok(
      new VariantTypeSettings({
        ...this.state,
        ...copyOf(input.content),
        revisionId: input.revisionId,
        revisionNo: this.state.revisionNo + 1,
        version: this.state.version + 1,
        revisedAt: input.now,
      }),
    );
  }
}

function copyOf(content: VariantTypeSettingsContent): VariantTypeSettingsContent {
  return {
    displayStyle: content.displayStyle,
    optionOrder: content.optionOrder,
    swatches: Object.freeze({ ...content.swatches }),
    sellerHelp: Object.freeze({ ...content.sellerHelp }),
  };
}

/** One option as the ordering reads it. */
export interface OrderableOption {
  readonly code: string;
  readonly labels: LocalizedText;
  readonly position: number;
}

// Units of one kind convert to a base (grams, millilitres, millimetres) so "500 g" sorts before
// "1 kg". A label with an amount but an unknown unit (or none) is grouped by that unit as written.
const UNITS: Readonly<Record<string, { readonly kind: string; readonly factor: number }>> =
  Object.freeze({
    mg: { kind: 'mass', factor: 0.001 },
    g: { kind: 'mass', factor: 1 },
    gm: { kind: 'mass', factor: 1 },
    gram: { kind: 'mass', factor: 1 },
    grams: { kind: 'mass', factor: 1 },
    kg: { kind: 'mass', factor: 1000 },
    ml: { kind: 'volume', factor: 1 },
    cl: { kind: 'volume', factor: 10 },
    l: { kind: 'volume', factor: 1000 },
    litre: { kind: 'volume', factor: 1000 },
    litres: { kind: 'volume', factor: 1000 },
    liter: { kind: 'volume', factor: 1000 },
    liters: { kind: 'volume', factor: 1000 },
    mm: { kind: 'length', factor: 1 },
    cm: { kind: 'length', factor: 10 },
    m: { kind: 'length', factor: 1000 },
  });

const AMOUNT = /^\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)/;

/** The amount a label starts with, in its kind's base unit, or null when it has none. */
export function sizeOf(label: string): { readonly kind: string; readonly value: number } | null {
  const match = AMOUNT.exec(label);
  if (match === null) return null;
  const amount = Number(match[1]!.replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  const unit = UNITS[match[2]!.toLowerCase()];
  if (unit === undefined) return { kind: match[2]!.toLowerCase(), value: amount };
  return { kind: unit.kind, value: amount * unit.factor };
}

/**
 * The options in the order buyers see them in `locale` (the default locale's label stands in for
 * a missing one). Stable: ties keep the manual order. Pure.
 */
export function orderOptions<O extends OrderableOption>(
  options: readonly O[],
  order: VariantOptionOrder,
  locale: string,
  defaultLocale: string,
): O[] {
  const manual = [...options].sort((a, b) => a.position - b.position || compare(a.code, b.code));
  if (order === 'manual') return manual;
  const labelOf = (option: O) =>
    option.labels[locale] ?? option.labels[defaultLocale] ?? option.code;
  if (order === 'alphabetical') {
    const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
    return manual
      .map((option, index) => ({ option, index }))
      .sort((a, b) => collator.compare(labelOf(a.option), labelOf(b.option)) || a.index - b.index)
      .map(({ option }) => option);
  }
  // by-size: grouped by unit kind in the order the kinds first appear, labels without an amount
  // last; inside a group by amount; ties keep the manual order. The default locale's label is
  // read, so the order is the same in every language.
  const kinds: string[] = [];
  const sized = manual.map((option, index) => {
    const size = sizeOf(option.labels[defaultLocale] ?? labelOf(option));
    if (size !== null && !kinds.includes(size.kind)) kinds.push(size.kind);
    return { option, index, size };
  });
  return sized
    .sort((a, b) => {
      if (a.size === null || b.size === null) {
        return (a.size === null ? 1 : 0) - (b.size === null ? 1 : 0) || a.index - b.index;
      }
      return (
        kinds.indexOf(a.size.kind) - kinds.indexOf(b.size.kind) ||
        a.size.value - b.size.value ||
        a.index - b.index
      );
    })
    .map(({ option }) => option);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
