import type { OperatorCommand } from '../../../../platform/operator/operator-command';
import { IssueFirstAdminInvitation } from '../../application/use-cases/issue-first-admin-invitation.use-case';
import { IssueSecondAdminInvitation } from '../../application/use-cases/issue-second-admin-invitation.use-case';
import { ResetAdminSecondFactor } from '../../application/use-cases/reset-admin-second-factor.use-case';

/**
 * The two operator routines of identity design 7.4, run by the platform's operator runner as the
 * Market's `SYSTEM` actor after the operator line is written (platform-audit 9.2). Each reaches
 * one use case with the `system` rule; the address (`--email`) is personal data and goes only
 * to the use case. The body holds codes and ids only.
 */
export const IDENTITY_OPERATOR_COMMANDS: readonly OperatorCommand[] = Object.freeze([
  {
    name: 'first-admin',
    flags: ['email'],
    async run(app, context, values) {
      const result = await app
        .get(IssueFirstAdminInvitation)
        .execute(context, { email: values.email! });
      return result.ok
        ? {
            done: true,
            body: {
              outcome: result.value.code,
              invitationId: result.value.invitationId,
              replaced: result.value.replaced,
            },
          }
        : { done: false, body: { outcome: result.error.code } };
    },
  },
  {
    // Owner decision 22 Nov 2026: the bootstrap of a Market's second admin, once.
    name: 'second-admin',
    flags: ['email'],
    async run(app, context, values) {
      const result = await app
        .get(IssueSecondAdminInvitation)
        .execute(context, { email: values.email! });
      return result.ok
        ? {
            done: true,
            body: { outcome: result.value.code, invitationId: result.value.invitationId },
          }
        : { done: false, body: { outcome: result.error.code } };
    },
  },
  {
    name: 'reset-admin-second-factor',
    flags: ['email'],
    async run(app, context, values) {
      const result = await app
        .get(ResetAdminSecondFactor)
        .execute(context, { email: values.email! });
      return result.ok
        ? {
            done: true,
            body: {
              outcome: result.value.code,
              accountId: result.value.accountId,
              revokedSessions: result.value.revokedSessions,
            },
          }
        : { done: false, body: { outcome: result.error.code } };
    },
  },
]);

export const IDENTITY_OPERATOR_USAGE =
  'usage: identity-admin <first-admin|second-admin|reset-admin-second-factor> --market <id> --email <address>';
