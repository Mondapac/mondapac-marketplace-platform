import {
  isCategoryImageUploadRequest,
  isStoreImageUploadRequest,
  isStoreProfileSaveRequest,
} from './configure-app';

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

describe('isStoreProfileSaveRequest', () => {
  it('takes the large body of the whole-profile PUT with a seller session and CSRF header', () => {
    expect(isStoreProfileSaveRequest('PUT', '/sellers/store-profile', OK)).toBe(true);
    expect(isStoreProfileSaveRequest('PUT', '/sellers/store-profile/?x=1', OK)).toBe(true);
  });

  it.each([
    ['no headers at all', undefined],
    ['no cookie', { 'x-csrf-token': 'token' }],
    ['no CSRF header', { cookie: COOKIE }],
    ['a customer cookie', { cookie: '__Host-session-customer-AU=abc', 'x-csrf-token': 't' }],
    ['an admin cookie', { cookie: '__Host-session-admin-AU=abc', 'x-csrf-token': 't' }],
  ])('keeps the 64 KiB parser for %s', (_, headers) => {
    expect(isStoreProfileSaveRequest('PUT', '/sellers/store-profile', headers)).toBe(false);
  });

  it.each([
    ['GET', '/sellers/store-profile'],
    ['POST', '/sellers/store-profile'],
    ['PUT', '/sellers/store-profile/about'],
    ['PUT', '/sellers/store-profile/logo'],
    ['PUT', '/sellers/store-profile/extra'],
    [undefined, '/sellers/store-profile'],
    ['PUT', undefined],
  ])('is false for %s %s even with a session', (method, url) => {
    expect(isStoreProfileSaveRequest(method, url, OK)).toBe(false);
  });
});

describe('isCategoryImageUploadRequest', () => {
  const ID = '0193b2c4-1111-7222-8333-444455556666';
  const ADMIN = '__Host-session-admin-AU=abc123_-XYZ';
  const ADMIN_OK = { cookie: ADMIN, 'x-csrf-token': 'token' };

  it('takes the large body of a PUT of a category image with an admin session and CSRF header', () => {
    expect(
      isCategoryImageUploadRequest('PUT', `/catalog/admin/categories/${ID}/image`, ADMIN_OK),
    ).toBe(true);
    expect(
      isCategoryImageUploadRequest('PUT', `/catalog/admin/categories/${ID}/image/?x=1`, {
        cookie: `theme=dark; ${ADMIN}`,
        'x-csrf-token': 'token',
      }),
    ).toBe(true);
  });

  it.each([
    ['no headers at all', undefined],
    ['no cookie', { 'x-csrf-token': 'token' }],
    ['no CSRF header', { cookie: ADMIN }],
    ['an empty CSRF header', { cookie: ADMIN, 'x-csrf-token': '' }],
    ['a seller cookie', { cookie: COOKIE, 'x-csrf-token': 't' }],
    ['a customer cookie', { cookie: '__Host-session-customer-AU=abc', 'x-csrf-token': 't' }],
    [
      'a cookie that only ends like an admin one',
      { cookie: 'x__Host-session-admin-AU=a', 'x-csrf-token': 't' },
    ],
    ['an empty admin cookie value', { cookie: '__Host-session-admin-AU=', 'x-csrf-token': 't' }],
  ])('keeps the 64 KiB parser for %s', (_, headers) => {
    expect(
      isCategoryImageUploadRequest('PUT', `/catalog/admin/categories/${ID}/image`, headers),
    ).toBe(false);
  });

  it.each([
    ['POST', `/catalog/admin/categories/${ID}/image`],
    ['GET', `/catalog/admin/categories/${ID}/image`],
    ['PUT', `/catalog/admin/categories/${ID}`],
    ['PUT', `/catalog/admin/categories/${ID}/image/remove`],
    ['PUT', '/catalog/admin/categories/not-a-uuid/image'],
    ['PUT', `/catalog/seller/categories/${ID}/image`],
    [undefined, `/catalog/admin/categories/${ID}/image`],
    ['PUT', undefined],
  ])('is false for %s %s even with a session', (method, url) => {
    expect(isCategoryImageUploadRequest(method, url, ADMIN_OK)).toBe(false);
  });
});
