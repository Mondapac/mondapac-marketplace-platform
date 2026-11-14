import { Logger } from '@nestjs/common';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { MailTransport } from '../../../platform/mail/mail-transport';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { AlertMessage, AlertMessenger } from '../application/ports/alert-messenger';
import type { DeliveryChannel, DeliveryOutcome } from '../domain/delivery';
import type { RosterMember } from '../domain/roster';

/**
 * {@link AlertMessenger} for package 2: email goes through the platform mail transport, from the
 * Market's sender; SMS, a voice call and team chat have no provider yet (SMS is the optional paid
 * add-on of package 6 and the notifications SMS work), so they answer `not-configured` and the
 * timeline shows it. Logs the member's code, the channel and an outcome only.
 */
export class MailAlertMessenger implements AlertMessenger {
  readonly #logger = new Logger('SecurityAlertMessenger');

  constructor(
    private readonly mail: MailTransport,
    private readonly markets: MarketRegistry,
  ) {}

  async send(
    market: MarketContext,
    member: RosterMember,
    channel: DeliveryChannel,
    message: AlertMessage,
  ): Promise<DeliveryOutcome> {
    if (channel !== 'email') return 'not-configured';
    if (member.email === null) return 'no-contact';
    const { fromAddress, fromName } = this.markets.get(market.marketId).identity.mail;
    try {
      await this.mail.send({
        to: member.email,
        from: { address: fromAddress, name: fromName },
        subject: message.subject,
        text: message.text,
      });
      return 'sent';
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'unknown';
      this.#logger.warn({
        msg: 'security.alert-mail-failed',
        recipient: member.code,
        code: code.slice(0, 64),
        marketId: market.marketId,
      });
      return 'failed';
    }
  }
}
