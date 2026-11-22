import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import { MAX_CHANGE_REASON_LENGTH } from '../../domain/registry';
import {
  MAX_TERM_LENGTH,
  MAX_TERMS_PER_LOCALE,
  MAX_TYPE_DESCRIPTION_LENGTH,
  MAX_TYPE_NAME_LENGTH,
  VERIFICATION_MODES,
} from '../../domain/type-revision';
import { adminOf, type RegistryDependencies } from '../registry/registry.shared';

export interface TypeNewOptionsOutput {
  /** The Market's supported locales: the form has one wording section per locale. */
  readonly locales: string[];
  readonly verificationModes: string[];
  readonly defaultBases: string[];
  /** The badge artwork the storefront has; `text` shows the type's name. */
  readonly badgeArtworkKeys: string[];
  readonly limits: {
    readonly codeMinLength: number;
    readonly codeMaxLength: number;
    readonly nameMaxLength: number;
    readonly descriptionMaxLength: number;
    readonly claimTermsPerLocale: number;
    readonly claimTermMaxLength: number;
    readonly reasonMaxLength: number;
  };
}

export type TypeNewOptionsFailure = { readonly code: 'access.denied' };

/**
 * `types.new-options` (new-type design 5; FE-091): what the New type form offers, so the panel
 * hard-codes neither the Market's locales nor the artwork list nor the limits. Reads no row.
 * Rule: key `certification.type.edit` (the form is for proposing), the admin population.
 */
export class TypeNewOptions extends UseCase<
  Record<string, never>,
  TypeNewOptionsOutput,
  TypeNewOptionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-new-options',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<TypeNewOptionsOutput, TypeNewOptionsFailure>> {
    if (adminOf(context, { write: false }) === null) {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return Promise.resolve(
      ok({
        locales: [...this.deps.supportedLocales(context.market)],
        verificationModes: [...VERIFICATION_MODES],
        defaultBases: ['SELLER_REQUIRED', 'NOT_APPLICABLE'],
        badgeArtworkKeys: [...this.deps.badgeArtworkKeys],
        limits: {
          codeMinLength: 2,
          codeMaxLength: 32,
          nameMaxLength: MAX_TYPE_NAME_LENGTH,
          descriptionMaxLength: MAX_TYPE_DESCRIPTION_LENGTH,
          claimTermsPerLocale: MAX_TERMS_PER_LOCALE,
          claimTermMaxLength: MAX_TERM_LENGTH,
          reasonMaxLength: MAX_CHANGE_REASON_LENGTH,
        },
      }),
    );
  }
}
