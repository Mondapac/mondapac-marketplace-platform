import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT, CATALOG_VARIANT_TYPE_EDIT } from '../../contracts/permissions';
import { VariantTypeSettingsChangedAudit } from '../../domain/audit';
import {
  DEFAULT_VARIANT_TYPE_SETTINGS,
  normaliseColour,
  VARIANT_DISPLAY_STYLES,
  VARIANT_OPTION_ORDERS,
  VariantTypeSettings,
  type VariantDisplayStyle,
  type VariantOptionOrder,
  type VariantTypeSettingsContent,
  type VariantTypeSettingsRefusal,
} from '../../domain/variant-type-settings';
import {
  closedInput,
  editorAccountOf,
  refuseClaimTexts,
  type AttributeWriteFailure,
  type FieldIssue,
} from '../attributes/attribute-editor';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { VariantAdminReader } from '../ports/variant-admin.reader';
import type { VariantTypeSettingsStore } from '../ports/variant-type-settings.store';
import { definitionIdOf } from '../variants/variant-admin.shared';

export interface VariantTypeSettingsEditDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly variantAdminReader: VariantAdminReader;
  readonly variantTypeSettings: VariantTypeSettingsStore;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface VariantTypeSettingsView {
  readonly id: string;
  readonly settingsVersion: number;
  readonly displayStyle: VariantDisplayStyle;
  readonly optionOrder: VariantOptionOrder;
}

export type VariantTypeSettingsEditFailure =
  | AttributeWriteFailure
  | { readonly code: 'variant-type.not-found' }
  | { readonly code: 'variant-type.stale' }
  | { readonly code: 'variant-type.invalid'; readonly fields: readonly FieldIssue[] };

const KEYS = ['id', 'version', 'displayStyle', 'optionOrder', 'swatches', 'sellerHelp'] as const;
/** The longest help text read before the domain's check (which allows 200 characters). */
const MAX_HELP_INPUT = 400;
const MAX_SWATCH_INPUT = 400;

const field = (path: string, code: string): { ok: false; error: VariantTypeSettingsEditFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: VariantTypeSettingsEditFailure;
  };

/** Reads the closed body into content; shapes only, the domain checks the values. */
function contentOf(
  body: Record<string, unknown>,
): Result<VariantTypeSettingsContent, VariantTypeSettingsEditFailure> {
  const style = body['displayStyle'];
  if (!(VARIANT_DISPLAY_STYLES as readonly unknown[]).includes(style)) {
    return field('displayStyle', 'value');
  }
  const order = body['optionOrder'];
  if (!(VARIANT_OPTION_ORDERS as readonly unknown[]).includes(order)) {
    return field('optionOrder', 'value');
  }
  const rawSwatches = body['swatches'] ?? {};
  if (typeof rawSwatches !== 'object' || rawSwatches === null || Array.isArray(rawSwatches)) {
    return field('swatches', 'type');
  }
  const swatchEntries = Object.entries(rawSwatches as Record<string, unknown>);
  if (swatchEntries.length > MAX_SWATCH_INPUT) return field('swatches', 'too-many');
  const swatches: Record<string, string> = {};
  for (const [option, raw] of swatchEntries) {
    const colour = normaliseColour(raw);
    if (colour === null) return field(`swatches.${option.slice(0, 64)}`, 'format');
    swatches[option] = colour;
  }
  const rawHelp = body['sellerHelp'] ?? {};
  if (typeof rawHelp !== 'object' || rawHelp === null || Array.isArray(rawHelp)) {
    return field('sellerHelp', 'type');
  }
  const sellerHelp: Record<string, string> = {};
  for (const [locale, raw] of Object.entries(rawHelp as Record<string, unknown>)) {
    if (raw === null || raw === '') continue;
    if (typeof raw !== 'string' || raw.length > MAX_HELP_INPUT) {
      return field(`sellerHelp.${locale.slice(0, 16)}`, 'type');
    }
    const text = raw.trim();
    if (text !== '') sellerHelp[locale] = text;
  }
  return ok({
    displayStyle: style as VariantDisplayStyle,
    optionOrder: order as VariantOptionOrder,
    swatches,
    sellerHelp,
  });
}

function refusalOf(refusal: VariantTypeSettingsRefusal): VariantTypeSettingsEditFailure {
  const at = (path: string, code: string): VariantTypeSettingsEditFailure => ({
    code: 'variant-type.invalid',
    fields: [{ path, code }],
  });
  switch (refusal.code) {
    case 'variant-type.display-style-invalid':
      return at('displayStyle', 'value');
    case 'variant-type.option-order-invalid':
      return at('optionOrder', 'value');
    case 'variant-type.swatches-too-many':
      return at('swatches', 'too-many');
    case 'variant-type.swatch-invalid':
      return at(`swatches.${refusal.option}`, 'format');
    case 'variant-type.swatch-unknown-option':
      return at(`swatches.${refusal.option}`, 'unknown-option');
    case 'variant-type.help-invalid':
      return at(`sellerHelp.${refusal.locale}`, 'invalid');
    case 'variant-type.locale-invalid':
      return at(`sellerHelp.${refusal.locale}`, 'locale');
  }
}

const shapeOf = (content: VariantTypeSettingsContent, revisionNo: number) => ({
  revisionNo,
  displayStyle: content.displayStyle,
  optionOrder: content.optionOrder,
  swatchCount: Object.keys(content.swatches).length,
  sellerHelpCount: Object.keys(content.sellerHelp).length,
});

/**
 * `variant-type-settings.edit` (variants V6, the Variant types tab's details panel): an admin
 * saves how buyers choose one variant type, the whole content each time, as its next insert-only
 * revision. Names, options and labels are not here: they stay in Attributes. Rule: both
 * `catalog.variant-type.edit` and `catalog.attribute.edit` (both protected) and the admin
 * population; never in an acting-as session. The request names the settings version it read
 * (0 while the type uses the defaults); a later one is `variant-type.stale`. A swatch names an
 * option of the type (active or not) and a colour `#RRGGBB`; the seller help is one plain sentence
 * per supported locale and passes the claim-text check, fail closed, like an attribute's help. One
 * audit row: codes and counts, never a colour or a text.
 */
export class VariantTypeSettingsEdit extends UseCase<
  Record<string, unknown>,
  { readonly variantType: VariantTypeSettingsView },
  VariantTypeSettingsEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.variant-type-settings-edit',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_VARIANT_TYPE_EDIT.key, CATALOG_ATTRIBUTE_EDIT.key],
    },
  };

  readonly #logger = new Logger('VariantTypeSettingsEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: VariantTypeSettingsEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<
    Result<{ readonly variantType: VariantTypeSettingsView }, VariantTypeSettingsEditFailure>
  > {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.variant-type-settings-edit',
      code: result.ok ? 'revised' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<
    Result<{ readonly variantType: VariantTypeSettingsView }, VariantTypeSettingsEditFailure>
  > {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = definitionIdOf(body.value['id']);
    if (id === null) return err({ code: 'variant-type.not-found' });
    const version = body.value['version'];
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 0 ||
      version > 2_147_483_647
    ) {
      return field('version', 'type');
    }
    const content = contentOf(body.value);
    if (!content.ok) return content;
    const { market } = context;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    try {
      locales = this.deps.policy.locales(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    // Shapes and locales before the claim check, so no unchecked text is sent anywhere.
    const early = Object.keys(content.value.sellerHelp).find(
      (locale) => !locales.supported.includes(locale),
    );
    if (early !== undefined)
      return err(refusalOf({ code: 'variant-type.locale-invalid', locale: early }));
    // Checked before the unit opens: the certification facade opens its own.
    const claim = await refuseClaimTexts(
      this.deps,
      context,
      Object.entries(content.value.sellerHelp).map(([locale, text]) => ({
        path: `sellerHelp.${locale}`,
        locale,
        text,
      })),
    );
    if (claim !== null) return err(claim);

    try {
      return await this.deps.unitOfWork.run<
        { readonly variantType: VariantTypeSettingsView },
        VariantTypeSettingsEditFailure
      >(market, async () => {
        const type = await this.deps.variantAdminReader.variantType(market, id);
        if (type === null) return err({ code: 'variant-type.not-found' } as const);
        const optionCodes = new Set(type.options.map((option) => option.code));
        const stored = await this.deps.variantTypeSettings.find(market, id);
        const current = stored?.state.version ?? 0;
        if (current !== version) return err({ code: 'variant-type.stale' } as const);
        const revisionId = this.deps.ids.next<'VariantTypeSettingRevision'>();
        const now = this.deps.clock.now();
        const next =
          stored === null
            ? VariantTypeSettings.create({
                marketId: market.marketId,
                definitionId: id,
                revisionId,
                content: content.value,
                optionCodes,
                locales: locales.supported,
                now,
              })
            : stored.revise({
                revisionId,
                content: content.value,
                optionCodes,
                locales: locales.supported,
                now,
              });
        if (!next.ok) return err(refusalOf(next.error));
        if (stored === null) {
          await this.deps.variantTypeSettings.add(market, next.value, accountId);
        } else {
          await this.deps.variantTypeSettings.saveRevision(market, next.value, accountId);
        }
        await this.deps.audit.record(
          context,
          VariantTypeSettingsChangedAudit.entry(id, {
            before:
              stored === null
                ? shapeOf(DEFAULT_VARIANT_TYPE_SETTINGS, 0)
                : shapeOf(stored.state, stored.state.revisionNo),
            after: shapeOf(next.value.state, next.value.state.revisionNo),
          }),
        );
        return ok({
          variantType: {
            id,
            settingsVersion: next.value.state.version,
            displayStyle: next.value.state.displayStyle,
            optionOrder: next.value.state.optionOrder,
          },
        });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'variant-type.stale' });
      throw error;
    }
  }
}
