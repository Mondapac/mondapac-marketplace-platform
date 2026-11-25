import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AiEvaluationControl,
  PlaygroundAnswer,
} from '../../../../platform/ai/evaluations/evaluation-control';
import { SETTINGS_AI_MODELS_MANAGE } from '../../contracts/permissions';
import { AiPlaygroundRun } from '../../domain/audit';
import type { SettingsDependencies } from '../settings-dependencies';
import { adminAccountId, type SettingsFailure } from '../settings-flow';

export type { PlaygroundAnswer };

interface Input {
  readonly capability?: unknown;
  readonly sampleId?: unknown;
  /** Two distinct model families, side by side. */
  readonly families?: unknown;
}

export type AiPlaygroundFailure =
  | SettingsFailure
  | {
      readonly code: 'ai.playground-limit-reached';
    };

const logger = new Logger('RunAiPlayground');

/**
 * `settings.run-ai-playground`: an admin holding the protected AI models key runs one synthetic
 * evaluation sample on two models side by side (AI Gateway G4c; docs/design/domain/platform-ai.md
 * section 8, Playground). The body carries ids only: the capability, the sample id and two catalogue
 * families; no free text from the browser reaches a model. At most
 * `AI_PLAYGROUND_RUNS_PER_ADMIN_DAY` runs per admin per Market day (`ai.playground-limit-reached`),
 * counted before the calls; the calls are paid from the evaluation budget and closed like a run.
 * Each answer is the capability's own guarded text, plain and inert, with its check codes, cost,
 * latency and route kind; nothing is stored but the audit row `settings.ai-playground.run` (how
 * many models and what they cost, in a unit after the calls). No two-step code: it spends little and changes
 * nothing. Refused in an acting-as session.
 */
export class RunAiPlayground extends UseCase<
  Input,
  readonly PlaygroundAnswer[],
  AiPlaygroundFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.run-ai-playground',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_MODELS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<SettingsDependencies, 'unitOfWork' | 'audit'>,
    private readonly control: Pick<AiEvaluationControl, 'playground'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<readonly PlaygroundAnswer[], AiPlaygroundFailure>> {
    const adminId = adminAccountId(context);
    if (adminId === null) return err({ code: 'access.denied' });
    const { capability, sampleId, families } = input ?? {};
    const fields = [];
    if (typeof capability !== 'string') fields.push({ path: 'capability', code: 'type' });
    if (typeof sampleId !== 'string') fields.push({ path: 'sampleId', code: 'type' });
    if (
      !Array.isArray(families) ||
      families.length !== 2 ||
      families.some((family) => typeof family !== 'string') ||
      families[0] === families[1]
    ) {
      fields.push({ path: 'families', code: 'value' });
    }
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const result = await this.control.playground(
      context,
      adminId,
      capability as string,
      sampleId as string,
      families as string[],
    );
    logger.log({
      msg: 'settings.ai-playground',
      outcome: result.kind,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (result.kind === 'invalid') {
      return err({ code: 'validation.failed', fields: [{ path: result.path, code: result.code }] });
    }
    if (result.kind === 'limit-reached') return err({ code: 'ai.playground-limit-reached' });
    const answers = result.answers;
    const audited = await this.deps.unitOfWork.run<true, AiPlaygroundFailure>(
      context.market,
      async () => {
        await this.deps.audit.record(
          context,
          AiPlaygroundRun.entry(adminId, {
            after: {
              families: answers.length,
              spentMicroUsd: answers.reduce((total, answer) => total + answer.costMicroUsd, 0),
            },
          }),
        );
        return ok(true);
      },
    );
    if (!audited.ok) return audited;
    return ok(answers);
  }
}
