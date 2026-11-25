import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AiEvaluationControl,
  PlaygroundSuite,
} from '../../../../platform/ai/evaluations/evaluation-control';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import type { SettingsFailure } from '../settings-flow';

export type { PlaygroundSuite };

/**
 * `settings.view-ai-playground-samples`: an admin lists the samples the playground can run (AI
 * Gateway G4c; design section 8, Playground): per capability with an evaluation suite, each
 * synthetic sample's id and a plain-text summary of its input. Code only; no customer data. Seen
 * with the AI Gateway view key.
 */
export class ViewAiPlaygroundSamples extends UseCase<
  Record<string, never>,
  readonly PlaygroundSuite[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-playground-samples',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly control: Pick<AiEvaluationControl, 'samples'>,
  ) {
    super(gate);
  }

  protected handle(): Promise<Result<readonly PlaygroundSuite[], SettingsFailure>> {
    return Promise.resolve(ok(this.control.samples()));
  }
}
