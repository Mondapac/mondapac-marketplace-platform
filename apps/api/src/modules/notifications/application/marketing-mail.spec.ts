import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { MailSendError, type MailMessage } from '../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ContactEmailTarget, IdentityFacade } from '../../identity';
import type { LegalFacade } from '../../legal';
import { ConfigNotificationsPolicy } from '../infrastructure/config-notifications-policy';
import { HmacUnsubscribeTokens } from '../infrastructure/hmac-unsubscribe-tokens';
import { sendMarketingMail, type MarketingDependencies } from './marketing-mail-flow';
import type { SupportContactRepository } from './ports/support-contact.repository';
import { UnsubscribeMarketingEmail } from './use-cases/unsubscribe-marketing-email.use-case';
import { ViewUnsubscribeLink } from './use-cases/view-unsubscribe-link.use-case';

// The marketing mail rule and the one-click unsubscribe in memory on both Market fixtures: a mail
// goes only to a customer whose consent legal holds now; it names its sender and a contact and
// carries the unsubscribe link in its text and the RFC 8058 header; the link withdraws the consent
// with no sign-in, and a forged or foreign link changes nothing.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const BOB = id<'Account'>(0xb2);
const ALICE_EMAIL = 'alice.private@customer.example';

/** legal in memory: the set of accounts that agreed, per Market. */
class FakeLegal implements LegalFacade {
  readonly granted = new Set<string>();
  readonly calls: { method: string; actor: string }[] = [];
  marketingEmailConsentOf(context: CallContext, accountId: Id<'Account'>) {
    this.calls.push({ method: 'consent', actor: context.actor.kind });
    if (context.actor.kind !== 'system')
      return Promise.resolve(err({ code: 'access.denied' } as const));
    return Promise.resolve(
      ok({ granted: this.granted.has(`${context.market.marketId}|${accountId}`) }),
    );
  }
  withdrawMarketingEmailByLink(context: CallContext, accountId: Id<'Account'>) {
    this.calls.push({ method: 'withdraw', actor: context.actor.kind });
    if (context.actor.kind !== 'anonymous')
      return Promise.resolve(err({ code: 'access.denied' } as const));
    return Promise.resolve(
      ok({ withdrawn: this.granted.delete(`${context.market.marketId}|${accountId}`) }),
    );
  }
}

describe.each([['AU'], ['ZZ']] as const)('marketing mail in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system');
  const anonymous = testCallContext(market, 'anonymous');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const policy = new ConfigNotificationsPolicy(markets);
  const tokens = new HmacUnsubscribeTokens(new Uint8Array(32).fill(3));

  let legal: FakeLegal;
  let sent: MailMessage[];
  let addresses: Map<string, string>;
  let stored: string | null;
  let deps: MarketingDependencies;

  beforeEach(() => {
    legal = new FakeLegal();
    sent = [];
    addresses = new Map([[ALICE, ALICE_EMAIL]]);
    stored = 'help@market.example';
    const contacts: SupportContactRepository = {
      latest: () =>
        Promise.resolve(stored === null ? null : { version: 1, email: stored, changedAt: null! }),
      append: () => Promise.resolve(true),
    };
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      contacts,
      legal,
      identity: {
        contactEmailOf: (_context: CallContext, target: ContactEmailTarget) =>
          Promise.resolve(
            ok(target.kind === 'customer' ? (addresses.get(target.accountId) ?? null) : null),
          ),
      } as unknown as IdentityFacade,
      transport: {
        send: (message: MailMessage) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      policy,
      tokens,
    };
  });

  const mail = (accountId: Id<'Account'> = ALICE) => ({
    accountId,
    subject: 'New this week',
    text: 'Fresh dates are back in stock.\n\n',
  });

  it('sends nothing to a customer who never agreed', async () => {
    expect(await sendMarketingMail(deps, system, mail())).toBe('no-consent');
    expect(sent).toEqual([]);
  });

  it('sends with the sender, a contact and the unsubscribe link in the text and the header', async () => {
    legal.granted.add(`${code}|${ALICE}`);
    expect(await sendMarketingMail(deps, system, mail())).toBe('sent');
    expect(sent).toHaveLength(1);
    const [message] = sent;
    const token = tokens.issue(market, ALICE);
    const settings = markets.get(market.marketId).notifications!;
    expect(message).toMatchObject({
      to: ALICE_EMAIL,
      from: policy.mailSender(market),
      subject: 'New this week',
      listUnsubscribe: `${settings.oneClickUnsubscribeUrl}?token=${token}`,
    });
    expect(message!.text).toContain('Fresh dates are back in stock.\n\n--\n');
    expect(message!.text).toContain(`from ${policy.mailSender(market).name}.`);
    expect(message!.text).toContain(`${settings.unsubscribePage}?token=${token}`);
    expect(message!.text).toContain('Contact us: help@market.example');
    expect(message!.text).not.toMatch(/\{\w+\}/);
  });

  it('skips a Market without a contact, and an account without a usable address', async () => {
    legal.granted.add(`${code}|${ALICE}`);
    legal.granted.add(`${code}|${BOB}`);
    expect(await sendMarketingMail(deps, system, mail(BOB))).toBe('no-address');
    stored = null;
    const fallback = markets.get(market.marketId).notifications?.supportEmail;
    expect(await sendMarketingMail(deps, system, mail())).toBe(
      fallback === undefined ? 'contact-unconfigured' : 'sent',
    );
  });

  it('skips a Market without unsubscribe pages', async () => {
    legal.granted.add(`${code}|${ALICE}`);
    const bare = { ...deps, policy: { ...policy, unsubscribeUrls: () => null } } as never;
    expect(await sendMarketingMail(bare, system, mail())).toBe('unsubscribe-unconfigured');
    expect(sent).toEqual([]);
  });

  it('throws a transport failure back to the caller, and refuses a non-system caller', async () => {
    legal.granted.add(`${code}|${ALICE}`);
    const failing = {
      ...deps,
      transport: { send: () => Promise.reject(new MailSendError('mail.transport-refused')) },
    };
    await expect(sendMarketingMail(failing, system, mail())).rejects.toBeInstanceOf(MailSendError);
    await expect(sendMarketingMail(deps, anonymous, mail())).rejects.toThrow(
      'the consent could not be read',
    );
  });

  it('unsubscribes with the link, once, with no sign-in; the check changes nothing', async () => {
    legal.granted.add(`${code}|${ALICE}`);
    const view = new ViewUnsubscribeLink(gate, deps);
    const unsubscribe = new UnsubscribeMarketingEmail(gate, deps);
    const token = tokens.issue(market, ALICE);

    expect(await view.execute(anonymous, { token })).toEqual({ ok: true, value: { valid: true } });
    expect(legal.granted.size).toBe(1);
    expect(await unsubscribe.execute(anonymous, { token })).toEqual({
      ok: true,
      value: { unsubscribed: true },
    });
    expect(legal.granted.size).toBe(0);
    expect(await unsubscribe.execute(anonymous, { token })).toEqual({
      ok: true,
      value: { unsubscribed: true },
    });
    expect(await sendMarketingMail(deps, system, mail())).toBe('no-consent');
  });

  it('refuses a forged link and a link of another Market', async () => {
    legal.granted.add(`${code}|${ALICE}`);
    const unsubscribe = new UnsubscribeMarketingEmail(gate, deps);
    const view = new ViewUnsubscribeLink(gate, deps);
    const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    for (const token of [
      tokens.issue(otherMarket, ALICE),
      `u1.${ALICE}.${'A'.repeat(43)}`,
      undefined,
    ]) {
      const refused = { ok: false, error: { code: 'notifications.unsubscribe-link-invalid' } };
      expect(await view.execute(anonymous, { token })).toEqual(refused);
      expect(await unsubscribe.execute(anonymous, { token })).toEqual(refused);
    }
    expect(legal.granted.size).toBe(1);
    expect(legal.calls.filter((call) => call.method === 'withdraw')).toEqual([]);
  });
});
