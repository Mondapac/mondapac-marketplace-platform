import { ATTRIBUTE_DATA_TYPES, err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { AttributeDataType, Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import type { CategoryAuthorKind } from './platform-category';

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/;
const TEXT_MAX = 120;

/** Locale to text, for names and option labels (CA6). */
export type LocalizedText = { readonly [locale: string]: string };

export interface AttributeBounds {
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
}

export interface AttributeOption {
  readonly code: string;
  readonly labels: LocalizedText;
  readonly active: boolean;
  readonly position: number;
}

export interface AttributeDefinitionState {
  readonly id: Id<'AttributeDefinition'>;
  readonly marketId: MarketId;
  readonly code: string;
  readonly dataType: AttributeDataType;
  readonly localizable: boolean;
  readonly status: 'active' | 'archived';
  readonly createdByKind: CategoryAuthorKind;
  /** The first revision, created with the root. */
  readonly revisionId: Id<'AttributeDefinitionRevision'>;
  readonly revisionNo: number;
  /** ADR-0012 decision 3: set by people or the seed, never by a machine. */
  readonly material: boolean;
  readonly isVariantOption: boolean;
  readonly bounds: AttributeBounds;
  readonly names: LocalizedText;
  readonly options: readonly AttributeOption[];
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

export type AttributeDefinitionRefusal =
  | { readonly code: 'attribute-definition.code-invalid' }
  | { readonly code: 'attribute-definition.data-type-invalid' }
  | { readonly code: 'attribute-definition.name-required' }
  | { readonly code: 'attribute-definition.text-invalid'; readonly locale: string }
  | { readonly code: 'attribute-definition.locale-invalid' }
  | { readonly code: 'attribute-definition.bounds-invalid' }
  | { readonly code: 'attribute-definition.options-required' }
  | { readonly code: 'attribute-definition.options-not-allowed' }
  | { readonly code: 'attribute-definition.option-invalid' }
  | { readonly code: 'attribute-definition.option-repeated' }
  | { readonly code: 'attribute-definition.variant-option-needs-select' };

/** `true` when the text is one an administrator may show a customer (CA5, PlainText). */
function validText(text: string): boolean {
  const length = [...text].length;
  return text === text.trim() && length >= 1 && length <= TEXT_MAX && parsePlainText(text).ok;
}

function validLocalized(map: LocalizedText): AttributeDefinitionRefusal | null {
  for (const [locale, text] of Object.entries(map)) {
    if (!LOCALE.test(locale)) return { code: 'attribute-definition.locale-invalid' };
    if (!validText(text)) return { code: 'attribute-definition.text-invalid', locale };
  }
  return null;
}

const isFinitePositive = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= 1);

/**
 * A definition of an attribute (catalog design 2.1, 3.3; slice 3). This slice creates one from
 * the seed with its first revision and options; the editor's revisions, archive and the
 * two-person rule for clearing `material` arrive with slice 21. Code, data type and the
 * localizable flag never change after creation.
 */
export class AttributeDefinition {
  readonly #state: AttributeDefinitionState;

  private constructor(state: AttributeDefinitionState) {
    this.#state = Object.freeze(state);
  }

  static create(input: {
    readonly id: Id<'AttributeDefinition'>;
    readonly revisionId: Id<'AttributeDefinitionRevision'>;
    readonly marketId: MarketId;
    readonly code: string;
    readonly dataType: string;
    readonly localizable: boolean;
    readonly material: boolean;
    readonly isVariantOption: boolean;
    readonly bounds: AttributeBounds;
    readonly names: LocalizedText;
    readonly options: readonly AttributeOption[];
    readonly createdByKind: CategoryAuthorKind;
    readonly now: Temporal.Instant;
  }): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    if (!CODE.test(input.code)) return err({ code: 'attribute-definition.code-invalid' });
    if (!(ATTRIBUTE_DATA_TYPES as readonly string[]).includes(input.dataType)) {
      return err({ code: 'attribute-definition.data-type-invalid' });
    }
    const dataType = input.dataType as AttributeDataType;
    if (Object.keys(input.names).length === 0) {
      return err({ code: 'attribute-definition.name-required' });
    }
    const nameProblem = validLocalized(input.names);
    if (nameProblem !== null) return err(nameProblem);

    const textual = dataType === 'text' || dataType === 'long-text';
    const numeric = dataType === 'integer' || dataType === 'decimal';
    const { maxLength, min, max } = input.bounds;
    const boundsOk =
      isFinitePositive(maxLength) &&
      (maxLength === undefined || textual) &&
      ((min === undefined && max === undefined) || numeric) &&
      (min === undefined || Number.isFinite(min)) &&
      (max === undefined || Number.isFinite(max)) &&
      (min === undefined || max === undefined || min <= max);
    if (!boundsOk) return err({ code: 'attribute-definition.bounds-invalid' });

    const selectable = dataType === 'select' || dataType === 'multi-select';
    if (input.isVariantOption && dataType !== 'select') {
      return err({ code: 'attribute-definition.variant-option-needs-select' });
    }
    if (selectable && input.options.length === 0) {
      return err({ code: 'attribute-definition.options-required' });
    }
    if (!selectable && input.options.length > 0) {
      return err({ code: 'attribute-definition.options-not-allowed' });
    }
    const seen = new Set<string>();
    for (const option of input.options) {
      if (!CODE.test(option.code) || !Number.isInteger(option.position) || option.position < 0) {
        return err({ code: 'attribute-definition.option-invalid' });
      }
      if (seen.has(option.code)) return err({ code: 'attribute-definition.option-repeated' });
      seen.add(option.code);
      if (Object.keys(option.labels).length === 0) {
        return err({ code: 'attribute-definition.option-invalid' });
      }
      const labelProblem = validLocalized(option.labels);
      if (labelProblem !== null) return err(labelProblem);
    }

    return ok(
      new AttributeDefinition({
        id: input.id,
        marketId: input.marketId,
        code: input.code,
        dataType,
        localizable: input.localizable,
        status: 'active',
        createdByKind: input.createdByKind,
        revisionId: input.revisionId,
        revisionNo: 1,
        material: input.material,
        isVariantOption: input.isVariantOption,
        bounds: input.bounds,
        names: input.names,
        options: input.options,
        version: 1,
        createdAt: input.now,
      }),
    );
  }

  get state(): AttributeDefinitionState {
    return this.#state;
  }
}
