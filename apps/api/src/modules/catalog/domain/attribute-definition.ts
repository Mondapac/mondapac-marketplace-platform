import { ATTRIBUTE_DATA_TYPES, err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { AttributeDataType, Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import type { CategoryAuthorKind } from './platform-category';

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/;
const TEXT_MAX = 120;
const HELP_MAX = 300;
const NOTE_MAX = 1000;
/** The most values one definition may hold (Hassan, A1 review: bounded counts and forms). */
export const ATTRIBUTE_OPTIONS_MAX = 200;
const POSITION_MAX = 32_767;

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
  /** The value this one was merged into (attributes A8); kept unchanged by every edit here. */
  readonly mergedInto?: string | null;
}

/** The settings of a revision that only the admin screens set (attributes A2). */
export interface AttributeDisplaySettings {
  /** Locale to the help a seller sees next to the field. */
  readonly helpText: LocalizedText;
  readonly showOnProductPage: boolean;
  readonly searchable: boolean;
  readonly canBeFilter: boolean;
  /** For administrators only; never shown to sellers or buyers. */
  readonly internalNote: string | null;
  readonly position: number;
}

export const DEFAULT_DISPLAY_SETTINGS: AttributeDisplaySettings = Object.freeze({
  helpText: Object.freeze({}),
  showOnProductPage: true,
  searchable: false,
  canBeFilter: false,
  internalNote: null,
  position: 0,
});

export type AttributeDefinitionStatus = 'draft' | 'active' | 'archived';

export interface AttributeDefinitionState {
  readonly id: Id<'AttributeDefinition'>;
  readonly marketId: MarketId;
  readonly code: string;
  readonly dataType: AttributeDataType;
  readonly localizable: boolean;
  readonly status: AttributeDefinitionStatus;
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
  readonly display: AttributeDisplaySettings;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  /** When the current revision was written (equals `createdAt` for revision 1). */
  readonly revisedAt: Temporal.Instant;
}

export type AttributeDefinitionRefusal =
  | { readonly code: 'attribute-definition.code-invalid' }
  | { readonly code: 'attribute-definition.data-type-invalid' }
  | { readonly code: 'attribute-definition.name-required' }
  | {
      readonly code: 'attribute-definition.text-invalid';
      readonly locale: string;
      /** The value whose label it is; absent for the attribute's name. */
      readonly option?: string;
    }
  | { readonly code: 'attribute-definition.locale-invalid' }
  | { readonly code: 'attribute-definition.bounds-invalid' }
  | { readonly code: 'attribute-definition.options-required' }
  | { readonly code: 'attribute-definition.options-not-allowed' }
  | { readonly code: 'attribute-definition.option-invalid' }
  | { readonly code: 'attribute-definition.option-repeated' }
  | { readonly code: 'attribute-definition.variant-option-needs-select' }
  | { readonly code: 'attribute-definition.options-too-many' }
  | { readonly code: 'attribute-definition.help-invalid'; readonly locale: string }
  | { readonly code: 'attribute-definition.note-invalid' }
  | { readonly code: 'attribute-definition.position-invalid' }
  | { readonly code: 'attribute-definition.archived' }
  | { readonly code: 'attribute-definition.not-draft' }
  | { readonly code: 'attribute-definition.option-removed'; readonly option: string }
  | { readonly code: 'attribute-definition.variant-locked' }
  | { readonly code: 'attribute-definition.material-relaxation-required' }
  /** A relaxation was asked of a definition that is not a published `material` one. */
  | { readonly code: 'attribute-definition.not-material' }
  | { readonly code: 'attribute-definition.default-name-required'; readonly locale: string }
  | {
      readonly code: 'attribute-definition.default-label-required';
      readonly locale: string;
      readonly option: string;
    }
  | { readonly code: 'attribute-definition.active-option-required' };

/** `true` when the text is one an administrator may show a customer (CA5, PlainText). */
function validText(text: string): boolean {
  const length = [...text].length;
  return text === text.trim() && length >= 1 && length <= TEXT_MAX && parsePlainText(text).ok;
}

function validLocalized(map: LocalizedText, option?: string): AttributeDefinitionRefusal | null {
  for (const [locale, text] of Object.entries(map)) {
    if (!LOCALE.test(locale)) return { code: 'attribute-definition.locale-invalid' };
    if (!validText(text)) {
      return option === undefined
        ? { code: 'attribute-definition.text-invalid', locale }
        : { code: 'attribute-definition.text-invalid', locale, option };
    }
  }
  return null;
}

function validPlain(text: string, max: number): boolean {
  const length = [...text].length;
  return text === text.trim() && length >= 1 && length <= max && parsePlainText(text).ok;
}

function checkDisplay(display: AttributeDisplaySettings): AttributeDefinitionRefusal | null {
  for (const [locale, text] of Object.entries(display.helpText)) {
    if (!LOCALE.test(locale)) return { code: 'attribute-definition.locale-invalid' };
    if (!validPlain(text, HELP_MAX)) return { code: 'attribute-definition.help-invalid', locale };
  }
  if (display.internalNote !== null && !validPlain(display.internalNote, NOTE_MAX)) {
    return { code: 'attribute-definition.note-invalid' };
  }
  if (
    !Number.isInteger(display.position) ||
    display.position < 0 ||
    display.position > POSITION_MAX
  ) {
    return { code: 'attribute-definition.position-invalid' };
  }
  return null;
}

/** The content checks every revision passes, draft or not (CA5, CA6, catalog design 3.3). */
function checkContent(input: {
  readonly dataType: AttributeDataType;
  readonly names: LocalizedText;
  readonly bounds: AttributeBounds;
  readonly isVariantOption: boolean;
  readonly options: readonly AttributeOption[];
  readonly display: AttributeDisplaySettings;
  readonly optionsRequired: boolean;
}): AttributeDefinitionRefusal | null {
  const { dataType } = input;
  if (Object.keys(input.names).length === 0) return { code: 'attribute-definition.name-required' };
  const nameProblem = validLocalized(input.names);
  if (nameProblem !== null) return nameProblem;

  const textual = dataType === 'text' || dataType === 'long-text';
  const numeric = dataType === 'integer' || dataType === 'decimal';
  const { maxLength, min, max } = input.bounds;
  const boundsOk =
    isFinitePositive(maxLength) &&
    (maxLength === undefined || textual) &&
    ((min === undefined && max === undefined) || numeric) &&
    (min === undefined || Number.isFinite(min)) &&
    (max === undefined || Number.isFinite(max)) &&
    (dataType !== 'integer' ||
      ((min === undefined || Number.isSafeInteger(min)) &&
        (max === undefined || Number.isSafeInteger(max)))) &&
    (min === undefined || max === undefined || min <= max);
  if (!boundsOk) return { code: 'attribute-definition.bounds-invalid' };

  const selectable = dataType === 'select' || dataType === 'multi-select';
  if (input.isVariantOption && dataType !== 'select') {
    return { code: 'attribute-definition.variant-option-needs-select' };
  }
  if (selectable && input.optionsRequired && input.options.length === 0) {
    return { code: 'attribute-definition.options-required' };
  }
  if (!selectable && input.options.length > 0) {
    return { code: 'attribute-definition.options-not-allowed' };
  }
  if (input.options.length > ATTRIBUTE_OPTIONS_MAX) {
    return { code: 'attribute-definition.options-too-many' };
  }
  const seen = new Set<string>();
  for (const option of input.options) {
    if (!CODE.test(option.code) || !Number.isInteger(option.position) || option.position < 0) {
      return { code: 'attribute-definition.option-invalid' };
    }
    if (seen.has(option.code)) return { code: 'attribute-definition.option-repeated' };
    seen.add(option.code);
    if (Object.keys(option.labels).length === 0) {
      return { code: 'attribute-definition.option-invalid' };
    }
    const labelProblem = validLocalized(option.labels, option.code);
    if (labelProblem !== null) return labelProblem;
  }
  return checkDisplay(input.display);
}

const isFinitePositive = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= 1);

/**
 * What a definition seen by sellers must hold (attributes A2): the name in the Market's default
 * locale, and for a select type at least one active value, each active value labelled in that
 * locale. Publishing checks it, and so does every edit of a published definition.
 */
export function publishableRefusal(
  state: Pick<AttributeDefinitionState, 'names' | 'dataType' | 'options'>,
  defaultLocale: string,
): AttributeDefinitionRefusal | null {
  if (!Object.hasOwn(state.names, defaultLocale)) {
    return { code: 'attribute-definition.default-name-required', locale: defaultLocale };
  }
  if (state.dataType === 'select' || state.dataType === 'multi-select') {
    const active = state.options.filter((option) => option.active);
    if (active.length === 0) return { code: 'attribute-definition.active-option-required' };
    const unlabelled = active.find((option) => !Object.hasOwn(option.labels, defaultLocale));
    if (unlabelled !== undefined) {
      return {
        code: 'attribute-definition.default-label-required',
        locale: defaultLocale,
        option: unlabelled.code,
      };
    }
  }
  return null;
}

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
    readonly display?: AttributeDisplaySettings;
    readonly createdByKind: CategoryAuthorKind;
    readonly now: Temporal.Instant;
  }): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    if (!CODE.test(input.code)) return err({ code: 'attribute-definition.code-invalid' });
    if (!(ATTRIBUTE_DATA_TYPES as readonly string[]).includes(input.dataType)) {
      return err({ code: 'attribute-definition.data-type-invalid' });
    }
    const dataType = input.dataType as AttributeDataType;
    const display = input.display ?? DEFAULT_DISPLAY_SETTINGS;
    const problem = checkContent({ ...input, dataType, display, optionsRequired: true });
    if (problem !== null) return err(problem);

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
        display,
        version: 1,
        createdAt: input.now,
        revisedAt: input.now,
      }),
    );
  }

  /**
   * A new definition by an administrator (attributes A2): a draft, invisible to sellers and buyers
   * until published. A select type may start without values; publishing needs one.
   */
  static createDraft(input: {
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
    readonly display: AttributeDisplaySettings;
    readonly now: Temporal.Instant;
  }): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    if (!CODE.test(input.code)) return err({ code: 'attribute-definition.code-invalid' });
    if (!(ATTRIBUTE_DATA_TYPES as readonly string[]).includes(input.dataType)) {
      return err({ code: 'attribute-definition.data-type-invalid' });
    }
    const dataType = input.dataType as AttributeDataType;
    const problem = checkContent({ ...input, dataType, optionsRequired: false });
    if (problem !== null) return err(problem);
    return ok(
      new AttributeDefinition({
        id: input.id,
        marketId: input.marketId,
        code: input.code,
        dataType,
        localizable: input.localizable,
        status: 'draft',
        createdByKind: 'admin',
        revisionId: input.revisionId,
        revisionNo: 1,
        material: input.material,
        isVariantOption: input.isVariantOption,
        bounds: input.bounds,
        names: input.names,
        options: input.options,
        display: input.display,
        version: 1,
        createdAt: input.now,
        revisedAt: input.now,
      }),
    );
  }

  /** A stored definition, as the repository read it. */
  static rehydrate(state: AttributeDefinitionState): AttributeDefinition {
    return new AttributeDefinition(state);
  }

  /**
   * The next revision (insert-only, CA3): names, help, settings, limits and values change; code,
   * data type and the localizable flag never do. A value is never removed, only deactivated; its
   * code never changes. Once published, the variant flag is fixed (products are built on it), and
   * clearing `material` needs the two-person request (catalog design 8.2), not an edit.
   */
  revise(input: {
    readonly revisionId: Id<'AttributeDefinitionRevision'>;
    readonly names: LocalizedText;
    readonly material: boolean;
    readonly isVariantOption: boolean;
    readonly bounds: AttributeBounds;
    readonly options: readonly AttributeOption[];
    readonly display: AttributeDisplaySettings;
    readonly now: Temporal.Instant;
  }): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    const current = this.#state;
    if (current.status === 'archived') return err({ code: 'attribute-definition.archived' });
    const published = current.status === 'active';
    if (published && input.isVariantOption !== current.isVariantOption) {
      return err({ code: 'attribute-definition.variant-locked' });
    }
    if (published && current.material && !input.material) {
      return err({ code: 'attribute-definition.material-relaxation-required' });
    }
    const before = new Map(current.options.map((option) => [option.code, option]));
    const kept = new Set(input.options.map((option) => option.code));
    for (const code of before.keys()) {
      if (!kept.has(code))
        return err({ code: 'attribute-definition.option-removed', option: code });
    }
    const options = input.options.map((option) => ({
      code: option.code,
      labels: option.labels,
      active: option.active,
      position: option.position,
      mergedInto: before.get(option.code)?.mergedInto ?? null,
    }));
    const problem = checkContent({
      dataType: current.dataType,
      names: input.names,
      bounds: input.bounds,
      isVariantOption: input.isVariantOption,
      options,
      display: input.display,
      optionsRequired: published,
    });
    if (problem !== null) return err(problem);
    return ok(
      new AttributeDefinition({
        ...current,
        revisionId: input.revisionId,
        revisionNo: current.revisionNo + 1,
        material: input.material,
        isVariantOption: input.isVariantOption,
        bounds: input.bounds,
        names: input.names,
        options,
        display: input.display,
        version: current.version + 1,
        revisedAt: input.now,
      }),
    );
  }

  /**
   * Draft to active (attributes A2): the name in the Market's default locale is required, and a
   * select type needs at least one active value, each active value with a default-locale label.
   * Other locales may be missing; buyers in those languages do not see the missing text.
   */
  publish(defaultLocale: string): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    const current = this.#state;
    if (current.status !== 'draft') return err({ code: 'attribute-definition.not-draft' });
    const problem = publishableRefusal(current, defaultLocale);
    if (problem !== null) return err(problem);
    return ok(
      new AttributeDefinition({ ...current, status: 'active', version: current.version + 1 }),
    );
  }

  /**
   * Whether `material` may be cleared on this definition through a two-person request (catalog
   * design 8.2): only a published definition that is `material` now. A draft clears it by an edit.
   */
  relaxableMaterial(): AttributeDefinitionRefusal | null {
    const current = this.#state;
    if (current.status === 'archived') return { code: 'attribute-definition.archived' };
    if (current.status !== 'active' || !current.material) {
      return { code: 'attribute-definition.not-material' };
    }
    return null;
  }

  /**
   * The next revision with `material` cleared and nothing else changed, applied by a confirmed
   * two-person request (catalog design 8.2). The store records the request on the revision, and
   * the database refuses the revision without a confirmed request of this definition.
   */
  clearMaterial(input: {
    readonly revisionId: Id<'AttributeDefinitionRevision'>;
    readonly now: Temporal.Instant;
  }): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    const problem = this.relaxableMaterial();
    if (problem !== null) return err(problem);
    const current = this.#state;
    return ok(
      new AttributeDefinition({
        ...current,
        revisionId: input.revisionId,
        revisionNo: current.revisionNo + 1,
        material: false,
        version: current.version + 1,
        revisedAt: input.now,
      }),
    );
  }

  /**
   * A draft that was never published is set aside (attributes A2). Nothing is deleted (CA3): the
   * definition becomes archived, so its code stays taken and its history stays readable.
   */
  discard(): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    const current = this.#state;
    if (current.status !== 'draft') return err({ code: 'attribute-definition.not-draft' });
    return ok(
      new AttributeDefinition({ ...current, status: 'archived', version: current.version + 1 }),
    );
  }

  get state(): AttributeDefinitionState {
    return this.#state;
  }
}
