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
  /** A value is added to a published definition only (attributes A5). */
  | { readonly code: 'attribute-definition.not-published' }
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
  | { readonly code: 'attribute-definition.active-option-required' }
  /** A value merge or conversion names a type that has no values (attributes A8). */
  | { readonly code: 'attribute-definition.not-select' }
  /** The two values of a merge are not two different, usable values (attributes A8). */
  | { readonly code: 'attribute-definition.merge-invalid' }
  /** Two attributes of a merge are of different types (attributes A8). */
  | { readonly code: 'attribute-definition.merge-type-mismatch' }
  /** A value of the merged attribute has no target value, or a target that cannot be used. */
  | { readonly code: 'attribute-definition.merge-unmapped'; readonly option: string }
  /** A `material` attribute is archived, and so merged, only with a second administrator. */
  | { readonly code: 'attribute-definition.merge-material' };

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
    // A merged value stays inactive (attributes A8): an edit cannot bring it back.
    const options = input.options.map((option) => {
      const mergedInto = before.get(option.code)?.mergedInto ?? null;
      return {
        code: option.code,
        labels: option.labels,
        active: mergedInto === null ? option.active : false,
        position: option.position,
        mergedInto,
      };
    });
    // Nor can an edit switch off a value that others were merged into.
    const stillActive = new Set(options.filter((option) => option.active).map((o) => o.code));
    if (
      options.some((option) => option.mergedInto !== null && !stillActive.has(option.mergedInto))
    ) {
      return err({ code: 'attribute-definition.merge-invalid' });
    }
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
   * The next revision with one more value, and nothing else changed (attributes A5: a seller's
   * suggestion was approved). The definition must be published and select-like; the value goes
   * last, active, with the labels given; every earlier value keeps its code, labels and place.
   * The same checks as an edit apply (the default-locale label, the count, the texts).
   */
  addOption(input: {
    readonly revisionId: Id<'AttributeDefinitionRevision'>;
    readonly code: string;
    readonly labels: LocalizedText;
    readonly now: Temporal.Instant;
  }): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    const current = this.#state;
    if (current.status === 'archived') return err({ code: 'attribute-definition.archived' });
    if (current.status !== 'active') return err({ code: 'attribute-definition.not-published' });
    if (current.options.some((option) => option.code === input.code)) {
      return err({ code: 'attribute-definition.option-repeated' });
    }
    const position =
      current.options.reduce((top, option) => Math.max(top, option.position), -1) + 1;
    return this.revise({
      revisionId: input.revisionId,
      names: current.names,
      material: current.material,
      isVariantOption: current.isVariantOption,
      bounds: current.bounds,
      options: [
        ...current.options,
        { code: input.code, labels: input.labels, active: true, position },
      ],
      display: current.display,
      now: input.now,
    });
  }

  /**
   * The next revision with the value `source` merged into `target` (attributes A8; plan ت۶): the
   * source stays in the list, inactive and marked "merged into" the target, so the storefront, the
   * filters and the index read the target for it. No product revision changes; the next save of a
   * product stores the target's code. A value that was merged into the source now points at the
   * target, so a chain is never longer than one step. Only a published select-like definition;
   * the source must be a value that is not already merged, the target an active one that is not
   * merged, and the two differ. Nothing else changes (names, flags, help and the other values).
   */
  mergeValues(input: {
    readonly revisionId: Id<'AttributeDefinitionRevision'>;
    readonly source: string;
    readonly target: string;
    readonly now: Temporal.Instant;
  }): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    const current = this.#state;
    if (current.status === 'archived') return err({ code: 'attribute-definition.archived' });
    if (current.status !== 'active') return err({ code: 'attribute-definition.not-published' });
    if (current.dataType !== 'select' && current.dataType !== 'multi-select') {
      return err({ code: 'attribute-definition.not-select' });
    }
    const source = current.options.find((option) => option.code === input.source);
    const target = current.options.find((option) => option.code === input.target);
    if (
      source === undefined ||
      target === undefined ||
      source.code === target.code ||
      (source.mergedInto ?? null) !== null ||
      !target.active ||
      (target.mergedInto ?? null) !== null
    ) {
      return err({ code: 'attribute-definition.merge-invalid' });
    }
    const options = current.options.map((option) => {
      if (option.code === source.code) {
        return { ...option, active: false, mergedInto: target.code };
      }
      return option.mergedInto === source.code ? { ...option, mergedInto: target.code } : option;
    });
    return ok(
      new AttributeDefinition({
        ...current,
        revisionId: input.revisionId,
        revisionNo: current.revisionNo + 1,
        options,
        version: current.version + 1,
        revisedAt: input.now,
      }),
    );
  }

  /**
   * Whether the definition may be archived at all (attributes A8): only a published one. A draft
   * is discarded instead, and an archived one stays archived.
   */
  archivable(): AttributeDefinitionRefusal | null {
    const current = this.#state;
    if (current.status === 'archived') return { code: 'attribute-definition.archived' };
    if (current.status !== 'active') return { code: 'attribute-definition.not-published' };
    return null;
  }

  /**
   * A published definition is archived (attributes A8): products that already carry its values
   * keep them, and no feature set offers it any more. Nothing is deleted (CA3, Q-K6). Whether it
   * is in an active feature set, has live variants or is `material` (a second administrator) is
   * checked by the use case, which reads those facts.
   */
  archive(): Result<AttributeDefinition, AttributeDefinitionRefusal> {
    const problem = this.archivable();
    if (problem !== null) return err(problem);
    const current = this.#state;
    return ok(
      new AttributeDefinition({ ...current, status: 'archived', version: current.version + 1 }),
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

/** Where one value of a merged attribute goes (attributes A8). */
export interface AttributeMergeOption {
  readonly sourceCode: string;
  readonly targetCode: string;
}

/**
 * Plans the merge of an attribute into another (attributes A8, plan decision ت۶): both are
 * published and of one type and one set of rules (localizable, bounds), neither is `material`, and every value of a choice
 * attribute, active or not, goes to an active value of the target. A type without values has no
 * mapping. Nothing here reads products: the use case reads the impact, and products keep their
 * values and are mapped when they are read.
 */
export function planAttributeMerge(
  source: AttributeDefinition,
  target: AttributeDefinition,
  mapping: Readonly<Record<string, string>>,
): Result<readonly AttributeMergeOption[], AttributeDefinitionRefusal> {
  const from = source.state;
  const to = target.state;
  if (from.id === to.id) return err({ code: 'attribute-definition.merge-invalid' });
  const archivable = source.archivable();
  if (archivable !== null) return err(archivable);
  if (to.status !== 'active') return err({ code: 'attribute-definition.merge-invalid' });
  // One type and one set of rules: a value of the source must be valid for the target as it is.
  if (
    from.dataType !== to.dataType ||
    from.localizable !== to.localizable ||
    from.bounds.maxLength !== to.bounds.maxLength ||
    from.bounds.min !== to.bounds.min ||
    from.bounds.max !== to.bounds.max
  ) {
    return err({ code: 'attribute-definition.merge-type-mismatch' });
  }
  // A `material` attribute on either side needs a second administrator, which a merge has not.
  if (from.material || to.material) return err({ code: 'attribute-definition.merge-material' });
  const choice = from.dataType === 'select' || from.dataType === 'multi-select';
  if (!choice) {
    return Object.keys(mapping).length === 0
      ? ok([])
      : err({ code: 'attribute-definition.not-select' });
  }
  const targets = new Set(
    to.options.filter((option) => option.active).map((option) => option.code),
  );
  const known = new Set(from.options.map((option) => option.code));
  for (const key of Object.keys(mapping)) {
    if (!known.has(key)) return err({ code: 'attribute-definition.merge-unmapped', option: key });
  }
  const plan: AttributeMergeOption[] = [];
  for (const option of from.options) {
    const goes = mapping[option.code];
    if (goes === undefined || !targets.has(goes)) {
      return err({ code: 'attribute-definition.merge-unmapped', option: option.code });
    }
    plan.push({ sourceCode: option.code, targetCode: goes });
  }
  return ok(plan);
}
