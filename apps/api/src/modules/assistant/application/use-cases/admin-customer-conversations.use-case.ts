import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminConversationDates,
  AdminConversationsRequest,
  CustomerConversationsFailure,
} from '../../contracts/customer-conversations.facade';
import { ASSISTANT_CUSTOMER_CONVERSATION_VIEW } from '../../contracts/permissions';
import type { AssistantDependencies } from '../assistant-dependencies';

type Page = { readonly rows: readonly AdminConversationDates[]; readonly total: number };

/** The largest page an admin's read answers (an export reads 10,000 and one more). */
const MAX_WINDOW = 10_001;

/**
 * `assistant.admin-customer-conversations`: how many assistant conversations one customer had
 * and one page of their dates, for the customer page (customers management phase 2b). Rule
 * `permissions [assistant.customer-conversation.view]`, a platform admin not acting as anyone.
 * Reads the conversation rows only: never a message, a card, the turn count or the model. Facade
 * only.
 */
export class AdminCustomerConversations extends UseCase<
  AdminConversationsRequest,
  Page,
  CustomerConversationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.admin-customer-conversations',
    rule: { kind: 'permissions', allOf: [ASSISTANT_CUSTOMER_CONVERSATION_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminConversationsRequest,
  ): Promise<Result<Page, CustomerConversationsFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      (Object.hasOwn(actor, 'actingAs') && (actor as { actingAs?: unknown }).actingAs != null)
    ) {
      return err({ code: 'access.denied' });
    }
    const window = {
      offset: Math.max(input.window.offset, 0),
      limit: Math.min(Math.max(input.window.limit, 0), MAX_WINDOW),
    };
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () => {
        const rows = await this.deps.conversations.datesOfAccount(
          context.market,
          input.accountId,
          input.direction,
          window,
        );
        const total = await this.deps.conversations.countOfAccount(context.market, input.accountId);
        return ok({ rows, total });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      rows: read.value.rows.map((row) => ({
        startedAt: row.startedAt.toString(),
        lastMessageAt: row.lastMessageAt.toString(),
      })),
      total: read.value.total,
    });
  }
}
