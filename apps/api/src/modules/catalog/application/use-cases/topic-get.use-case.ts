import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_TOPIC_READ } from '../../contracts/permissions';
import type { TopicRepository } from '../ports/topic.repository';
import { adminAccountOf, topicIdOf, viewOf, type TopicView } from '../topics/topic-views';

export interface TopicGetInput {
  readonly topicId?: unknown;
}

export type TopicGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'topic.not-found' };

export interface TopicGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topics: TopicRepository;
}

/**
 * `topic.get` (product tags package T1): one topic for the admin editor. Rule: the key
 * `catalog.topic.read` and the admin population. One read-only unit.
 */
export class TopicGet extends UseCase<
  TopicGetInput,
  { readonly topic: TopicView },
  TopicGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-get',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_READ.key] },
  };

  readonly #logger = new Logger('TopicGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicGetInput,
  ): Promise<Result<{ readonly topic: TopicView }, TopicGetFailure>> {
    const result = await this.#get(context, input);
    this.#logger.log({
      msg: 'catalog.topic-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #get(
    context: CallContext,
    input: TopicGetInput,
  ): Promise<Result<{ readonly topic: TopicView }, TopicGetFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const id = topicIdOf(input.topicId, 'topicId');
    if (!id.ok) return err({ code: 'topic.not-found' });
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.topics.findById(market, id.value)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'topic.not-found' });
    return ok({ topic: viewOf(read.value) });
  }
}
