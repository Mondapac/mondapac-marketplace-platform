import { isStoreImageUploadRequest } from './configure-app';

// Which requests may carry the large (5.8 MB) body of a store logo or banner (Hassan H4).

const COOKIE = '__Host-session-seller-AU=abc123_-XYZ';
const OK = { cookie: COOKIE, 'x-csrf-token': 'token' };

describe('isStoreImageUploadRequest', () => {
  it.each(['logo', 'banner'])(
    'takes the large body of a PUT %s with a seller session and CSRF header',
    (kind) => {
      expect(isStoreImageUploadRequest('PUT', `/sellers/store-profile/${kind}`, OK)).toBe(true);
      expect(isStoreImageUploadRequest('PUT', `/sellers/store-profile/${kind}/?x=1`, OK)).toBe(
        true,
      );
      expect(
        isStoreImageUploadRequest('PUT', `/sellers/store-profile/${kind}`, {
          cookie: `theme=dark; ${COOKIE}`,
          'x-csrf-token': 'token',
        }),
      ).toBe(true);
    },
  );

  it.each([
    ['no headers at all', undefined],
    ['no cookie', { 'x-csrf-token': 'token' }],
    ['no CSRF header', { cookie: COOKIE }],
    ['an empty CSRF header', { cookie: COOKIE, 'x-csrf-token': '' }],
    ['a customer cookie', { cookie: '__Host-session-customer-AU=abc', 'x-csrf-token': 't' }],
    ['an admin cookie', { cookie: '__Host-session-admin-AU=abc', 'x-csrf-token': 't' }],
    [
      'a cookie that only ends like a seller one',
      { cookie: 'x__Host-session-seller-AU=a', 'x-csrf-token': 't' },
    ],
    ['an empty seller cookie value', { cookie: '__Host-session-seller-AU=', 'x-csrf-token': 't' }],
  ])('keeps the 64 KiB parser for %s', (_, headers) => {
    expect(isStoreImageUploadRequest('PUT', '/sellers/store-profile/logo', headers)).toBe(false);
  });

  it.each([
    ['POST', '/sellers/store-profile/logo'],
    ['GET', '/sellers/store-profile/logo'],
    ['PUT', '/sellers/store-profile/about'],
    ['PUT', '/sellers/store-profile/avatar'],
    ['PUT', '/sellers/store-profile/logo/extra'],
    [undefined, '/sellers/store-profile/logo'],
    ['PUT', undefined],
  ])('is false for %s %s even with a session', (method, url) => {
    expect(isStoreImageUploadRequest(method, url, OK)).toBe(false);
  });
});
