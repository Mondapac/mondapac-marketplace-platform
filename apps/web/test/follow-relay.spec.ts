import { describe, expect, it } from 'vitest';
import { publicStoreOf, shopOf, StoreAnswerRefused } from '../src/storefront/real-sellers.ts';
import { isSessionPathAllowed, myStoresQuery } from '../src/storefront/session-relay.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const STORE = 'customers/me/followed-stores';

describe('relay paths of the store follows and invite link', () => {
  it('allows each route with its own narrowest method', () => {
    expect(isSessionPathAllowed('GET', STORE.split('/'))).toBe(true);
    expect(isSessionPathAllowed('GET', [...STORE.split('/'), ID])).toBe(true);
    expect(isSessionPathAllowed('PUT', [...STORE.split('/'), ID])).toBe(true);
    expect(isSessionPathAllowed('DELETE', [...STORE.split('/'), ID])).toBe(true);
    expect(isSessionPathAllowed('GET', ['customers', 'me', 'store-invitation'])).toBe(true);
    expect(isSessionPathAllowed('POST', ['customers', 'me', 'store-invitation'])).toBe(true);
    expect(isSessionPathAllowed('GET', ['promotions', 'stores', ID, 'follow-gift'])).toBe(true);
    expect(isSessionPathAllowed('GET', ['sellers', 'stores', 'green-grocer'])).toBe(true);
  });

  it('refuses every other method, id shape and path', () => {
    expect(isSessionPathAllowed('PUT', STORE.split('/'))).toBe(false);
    expect(isSessionPathAllowed('POST', STORE.split('/'))).toBe(false);
    expect(isSessionPathAllowed('PATCH', [...STORE.split('/'), ID])).toBe(false);
    expect(isSessionPathAllowed('PUT', [...STORE.split('/'), 'not-a-uuid'])).toBe(false);
    expect(isSessionPathAllowed('PUT', ['customers', 'me', 'store-invitation'])).toBe(false);
    expect(isSessionPathAllowed('DELETE', ['customers', 'me', 'store-invitation'])).toBe(false);
    expect(isSessionPathAllowed('POST', ['promotions', 'stores', ID, 'follow-gift'])).toBe(false);
    expect(isSessionPathAllowed('GET', ['sellers', 'stores', 'Green_Grocer'])).toBe(false);
    expect(isSessionPathAllowed('GET', ['sellers', 'stores', 'a', 'images'])).toBe(false);
    expect(isSessionPathAllowed('POST', ['sellers', 'stores', 'green-grocer'])).toBe(false);
    // The anonymous invite read is made by the server, never through the browser relay.
    expect(isSessionPathAllowed('GET', ['customers', 'store-invitations', 'abcDEF123456'])).toBe(
      false,
    );
  });

  it('passes only a well-shaped cursor and limit of My stores', () => {
    const base = 'http://storefront.localhost:3003/api/customers/me/followed-stores';
    expect(myStoresQuery(`${base}?cursor=abc_1-2.3=&limit=50`)).toBe(
      '?cursor=abc_1-2.3%3D&limit=50',
    );
    expect(myStoresQuery(`${base}?cursor=a b&limit=x&other=1`)).toBe('');
    expect(myStoresQuery(`${base}?sellerId=${ID}`)).toBe('');
    expect(myStoresQuery('not a url')).toBe('');
  });
});

describe('the store answer keeps the seller id only when it is well shaped', () => {
  const body = {
    slug: 'green-grocer',
    name: 'Green Grocer',
    serviceAreaCode: 'bne',
    sellingSince: 2024,
  };
  it('carries it to the store page', () => {
    expect(shopOf(publicStoreOf({ ...body, sellerId: ID }), 'Brisbane').sellerId).toBe(ID);
    expect(shopOf(publicStoreOf(body), 'Brisbane').sellerId).toBeUndefined();
  });
  it('refuses the answer whole when the id is malformed', () => {
    expect(() => publicStoreOf({ ...body, sellerId: 'x' })).toThrow(StoreAnswerRefused);
  });
});
