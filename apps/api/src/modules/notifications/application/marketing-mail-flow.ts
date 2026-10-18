import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { MailTransport } from '../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { IdentityFacade } from '../../identity';
import type { LegalFacade } from '../../legal';
import { renderTemplate } from '../domain/message-templates';
import type { NotificationsPolicy } from './ports/notifications-policy';
import type { SupportContactRepository } from './ports/support-contact.repository';
import type { UnsubscribeTokens } from './ports/unsubscribe-tokens';

// Marketing email and its one-click unsubscribe (personalization package 1b; owner decision 3 of
// 2026-10-18, Spam Act 2003). The one rule every marketing send goes through: it is sent only to
// a customer whose express consent `legal` holds now, it names its sender and a contact address,
// and it carries a working unsubscribe link in the text and the RFC 8058 one-click header. The
// unsubscribe link withdraws the consent in `legal` at once, with no sign-in. No address, token
// or account id reaches a log, an event or an error.

export interface MarketingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly contacts: SupportContactRepository;
  readonly legal: LegalFacade;
  readonly identity: IdentityFacade;
  readonly transport: MailTransport;
  readonly policy: NotificationsPolicy;
  readonly tokens: UnsubscribeTokens;
}

/** One marketing mail to one customer: the subject and plain text of the mail itself. */
export interface MarketingMailInput {
  readonly accountId: Id<'Account'>;
  readonly subject: string;
  readonly text: string;
}

/**
 * What happened to one marketing mail. Every outcome but `sent` is a skip, never an error: no
 * consent, no usable address, or a Market without unsubscribe pages or a contact address.
 */
export type MarketingMailOutcome =
  'sent' | 'no-consent' | 'no-address' | 'unsubscribe-unconfigured' | 'contact-unconfigured';

/**
 * Sends one marketing mail to one customer account, as the system actor (marketing sends are
 * jobs). Consent is asked from `legal` right before the send, so a withdrawal stops the next mail.
 * A transport failure throws, so the caller's job or delivery retries it.
 */
export async function sendMarketingMail(
  deps: MarketingDependencies,
  context: CallContext,
  input: MarketingMailInput,
): Promise<MarketingMailOutcome> {
  const consent = await deps.legal.marketingEmailConsentOf(context, input.accountId);
  if (!consent.ok) throw new Error('marketing-mail: the consent could not be read');
  if (!consent.value.granted) return 'no-consent';

  const token = deps.tokens.issue(context.market, input.accountId);
  const urls = deps.policy.unsubscribeUrls(context.market, token);
  if (urls === null) return 'unsubscribe-unconfigured';

  const contactEmail = await deps.unitOfWork.run<string | null, never>(
    context.market,
    async () => {
      const latest = await deps.contacts.latest(context.market);
      return ok(latest === null ? deps.policy.defaultSupportEmail(context.market) : latest.email);
    },
    { readOnly: true },
  );
  if (!contactEmail.ok || contactEmail.value === null) return 'contact-unconfigured';

  const to = await deps.identity.contactEmailOf(context, {
    kind: 'customer',
    accountId: input.accountId,
  });
  if (!to.ok) throw new Error('marketing-mail: the address could not be read');
  if (to.value === null) return 'no-address';

  const sender = deps.policy.mailSender(context.market);
  const footer = renderTemplate('marketing-footer', deps.policy.defaultLocale(context.market), {
    senderName: sender.name,
    unsubscribeUrl: urls.page,
    contactEmail: contactEmail.value,
  });
  await deps.transport.send({
    to: to.value,
    from: sender,
    subject: input.subject,
    text: `${input.text.replace(/\s+$/, '')}\n${footer.text}\n`,
    listUnsubscribe: urls.oneClick,
  });
  return 'sent';
}

export type UnsubscribeFailure = { readonly code: 'notifications.unsubscribe-link-invalid' };

/**
 * Whether an unsubscribe link is valid, for the storefront page before the click. Changes
 * nothing: a link scanner that opens the page never unsubscribes anyone.
 */
export function checkUnsubscribeLink(
  deps: Pick<MarketingDependencies, 'tokens'>,
  context: CallContext,
  input: { readonly token: unknown },
): Result<{ readonly valid: true }, UnsubscribeFailure> {
  return deps.tokens.verify(context.market, input?.token) === null
    ? err({ code: 'notifications.unsubscribe-link-invalid' })
    : ok({ valid: true });
}

/**
 * The one-click unsubscribe (RFC 8058 POST, or the button of the storefront page): withdraws the
 * marketing email consent of the account the link names. A second click answers the same.
 */
export async function unsubscribeMarketingEmail(
  deps: Pick<MarketingDependencies, 'tokens' | 'legal'>,
  context: CallContext,
  input: { readonly token: unknown },
): Promise<Result<{ readonly unsubscribed: true }, UnsubscribeFailure>> {
  const accountId = deps.tokens.verify(context.market, input?.token);
  if (accountId === null) return err({ code: 'notifications.unsubscribe-link-invalid' });
  const withdrawn = await deps.legal.withdrawMarketingEmailByLink(context, accountId);
  if (!withdrawn.ok) throw new Error('unsubscribe: the consent could not be withdrawn');
  return ok({ unsubscribed: true });
}
