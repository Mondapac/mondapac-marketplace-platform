import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import { ConfigNotificationsPolicy } from '../../modules/notifications/infrastructure/config-notifications-policy';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { SmsSendError, UnconfiguredSmsTransport } from './sms-transport';

describe('UnconfiguredSmsTransport', () => {
  it('refuses every send with a fixed code and no number in the error', async () => {
    const send = new UnconfiguredSmsTransport().send();
    await expect(send).rejects.toBeInstanceOf(SmsSendError);
    await expect(send).rejects.toMatchObject({ code: 'sms.transport-unconfigured' });
  });
});

describe('the Market sms sender id', () => {
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const policy = new ConfigNotificationsPolicy(markets);

  it.each([
    ['AU', 'MondaPac'],
    ['ZZ', 'MondaZZ'],
  ] as const)('is read from the configuration of %s', (code, senderId) => {
    expect(policy.smsSenderId(testMarketContext(code, 'default'))).toBe(senderId);
  });
});
