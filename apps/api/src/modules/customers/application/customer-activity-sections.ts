import { ok } from '@mondapac/shared-kernel';
import type { Money, Result } from '@mondapac/shared-kernel';
import {
  MAX_PAGED_ROWS,
  parseClosedValues,
  parseInstantRange,
  type InstantRange,
} from '../../../platform/list-query';
import { MARKETING_CHANNELS } from '../../legal';
import type {
  SectionBehaviour,
  SectionCart,
  SectionCartAddition,
  SectionConsentChange,
  SectionConversationDates,
  SectionReminderSent,
  SectionSavedItem,
} from './ports/customer-section-peers';
import type { ListValidationFailure } from './customer-list-flow';
import type { SectionListSpec } from './customer-section-lists';

// The customer page's shopping and privacy sections (customers management phase 2b): the cart and
// saved-for-later list (cart), the abandoned-cart reminders sent (notifications), the behaviour
// summary and add-to-cart history (engagement), the marketing consent and its history (legal) and
// the count and dates of assistant conversations (assistant). Each is one facade read of its
// owner, behind the owner's key; nothing here joins another module's data.

type NoFilters = Readonly<Record<string, never>>;
const noFilters = (): Result<NoFilters, ListValidationFailure> => ok({});

const query = <S extends string>(sort: S) => ({
  sorts: [sort] as const,
  defaultSort: sort,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxPage: Math.ceil(MAX_PAGED_ROWS / 25),
});

/** Money as it leaves over HTTP: the minor units as a decimal string. */
const moneyBody = (value: Money) => ({ amount: value.amount.toString(), currency: value.currency });

/** The cart as the page shows it: lines by ids, quantities and the price when added. */
export function cartAnswer(value: SectionCart) {
  return {
    savedCount: value.savedCount,
    cart:
      value.cart === null
        ? null
        : {
            createdAt: value.cart.createdAt,
            lastChangedAt: value.cart.lastChangedAt,
            lines: value.cart.lines.map((line) => ({
              ...line,
              priceAtAdd: moneyBody(line.priceAtAdd),
            })),
          },
  };
}

/** The behaviour summary as engagement answered it: counts and ids, never the search text. */
export const behaviourAnswer = (value: SectionBehaviour) => value;

/** The saved-for-later list (at most 100 per account). */
export const SAVED_ITEMS_SECTION: SectionListSpec<NoFilters, 'saved', SectionSavedItem> = {
  section: 'saved-items',
  filterKeys: [],
  parseFilters: noFilters,
  query: query('saved'),
  read: (peers, context, request) =>
    peers.cart.adminCustomerSavedItems(context, {
      accountId: request.accountId,
      direction: request.direction,
      window: request.window,
      withTotal: request.withTotal,
    }),
  sheet: {
    baseName: 'customer-saved-items',
    name: 'Saved for later',
    header: ['Saved item', 'Offer', 'Variant', 'Saved at'],
    cells: (row) => [row.savedItemId, row.offerId, row.variantId, row.savedAt],
  },
};

/** The abandoned-cart reminders sent (notifications keeps them 30 days). */
export const CART_REMINDERS_SECTION: SectionListSpec<NoFilters, 'sent', SectionReminderSent> = {
  section: 'cart-reminders',
  filterKeys: [],
  parseFilters: noFilters,
  query: query('sent'),
  read: (peers, context, request) =>
    peers.reminders.adminCustomerCartReminders(context, {
      accountId: request.accountId,
      direction: request.direction,
      window: request.window,
      withTotal: request.withTotal,
    }),
  sheet: {
    baseName: 'customer-cart-reminders',
    name: 'Cart reminders',
    header: ['Taken for sending at', 'Stage', 'Cart changed at'],
    cells: (row) => [row.sentAt, row.stage, row.cartChangedAt],
  },
};

/** The add-to-cart history (engagement keeps it 12 months), with a date range. */
export const CART_ADDITIONS_SECTION: SectionListSpec<InstantRange, 'added', SectionCartAddition> = {
  section: 'cart-additions',
  filterKeys: ['from', 'to'],
  parseFilters: (raw) => parseInstantRange(raw),
  query: query('added'),
  read: (peers, context, request) =>
    peers.behaviour.adminCustomerCartAdditions(context, {
      accountId: request.accountId,
      from: request.filters.from,
      to: request.filters.to,
      direction: request.direction,
      window: request.window,
      withTotal: request.withTotal,
    }),
  sheet: {
    baseName: 'customer-cart-additions',
    name: 'Added to cart',
    header: ['Added at', 'Offer', 'Variant'],
    cells: (row) => [row.addedAt, row.offerId, row.variantId],
  },
};

interface ConsentFilters {
  readonly channels: readonly (typeof MARKETING_CHANNELS)[number][] | null;
}

/** The changes of the marketing consent with their source, by channel. */
export const CONSENT_HISTORY_SECTION: SectionListSpec<
  ConsentFilters,
  'occurred',
  SectionConsentChange
> = {
  section: 'consent-history',
  filterKeys: ['channel'],
  parseFilters: (raw) => {
    const channels = parseClosedValues(raw['channel'], MARKETING_CHANNELS, 'filters.channel');
    return channels.ok ? ok({ channels: channels.value }) : channels;
  },
  query: query('occurred'),
  read: (peers, context, request) =>
    peers.consent.adminCustomerConsentHistory(context, {
      accountId: request.accountId,
      channels: request.filters.channels,
      direction: request.direction,
      window: request.window,
      withTotal: request.withTotal,
    }),
  sheet: {
    baseName: 'customer-consent-history',
    name: 'Consent history',
    header: ['Occurred at', 'Channel', 'Granted', 'Source'],
    cells: (row) => [row.occurredAt, row.channel, row.granted ? 'yes' : 'no', row.source],
  },
};

/** The assistant conversations by start: dates only, and the count beside every page. */
export const ASSISTANT_CONVERSATIONS_SECTION: SectionListSpec<
  NoFilters,
  'started',
  SectionConversationDates
> = {
  section: 'assistant-conversations',
  filterKeys: [],
  parseFilters: noFilters,
  query: query('started'),
  read: async (peers, context, request) => {
    const read = await peers.conversations.adminCustomerConversations(context, {
      accountId: request.accountId,
      direction: request.direction,
      window: request.window,
    });
    if (!read.ok) return read;
    return ok({
      rows: read.value.rows,
      total: request.withTotal ? read.value.total : null,
      extra: { conversationCount: read.value.total },
    });
  },
  sheet: {
    baseName: 'customer-assistant-conversations',
    name: 'Assistant conversations',
    header: ['Started at', 'Last message at'],
    cells: (row) => [row.startedAt, row.lastMessageAt],
  },
};

/** The current consent per channel as legal answered it. */
export const consentAnswer = (value: { readonly channels: readonly unknown[] }) => value;
