import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_VIEW } from '../../../settings';
import type { DescriptionWriterDependencies } from '../ai/description-writer.flow';

export interface AiModelSetup {
  /** `AI_KILL_SWITCH` is set on this Region Stack: every AI capability is off. */
  readonly killSwitch: boolean;
  /** Whether the Market has a provider key; the key itself never leaves the server. */
  readonly keyConfigured: boolean;
  /** The model id configured for each tier in the Market, or null. Server configuration. */
  readonly models: { readonly fast: string | null; readonly balanced: string | null };
}

/**
 * `catalog.admin-ai-model-setup`: what the admin AI settings card shows beside the switch and the
 * tier (owner decision 2026-11-13: the model id and the key are shown, read only). Rule: the
 * settings module's `settings.ai.view`.
 */
export class AdminAiModelSetup extends UseCase<
  Record<string, never>,
  AiModelSetup,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-ai-model-setup',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescriptionWriterDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<AiModelSetup, { readonly code: 'access.denied' }>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return Promise.resolve(ok(this.deps.model.setup(context.market)));
  }
}
