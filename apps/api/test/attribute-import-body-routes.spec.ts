import { isAttributeImportUploadRequest } from '../src/configure-app';
import { CSRF_HEADER } from '../src/platform/call-context/csrf';

// Which requests get the large raw body parser for the attribute import (attributes package A9):
// only the check and the run, only as POST, only with an admin session cookie and the CSRF header,
// and never the other routes under the same prefix.

const admin = { cookie: '__Host-session-admin-AU=abc123', [CSRF_HEADER]: 'token' };

describe('attribute import body routes', () => {
  it.each([
    '/catalog/admin/attribute-imports/check',
    '/catalog/admin/attribute-imports/run/',
    '/catalog/admin/attribute-imports/check?x=1',
  ])('gives the large body to POST %s', (url) => {
    expect(isAttributeImportUploadRequest('POST', url, admin)).toBe(true);
  });

  it.each([
    ['GET', '/catalog/admin/attribute-imports/check'],
    ['PUT', '/catalog/admin/attribute-imports/run'],
    [undefined, '/catalog/admin/attribute-imports/check'],
    ['POST', undefined],
    ['POST', '/catalog/admin/attribute-imports'],
    ['POST', '/catalog/admin/attribute-imports/other'],
    ['POST', '/catalog/admin/attribute-imports/check/extra'],
    ['POST', '/catalog/admin/attributes'],
    ['POST', '/catalog/seller/attribute-imports/check'],
  ])('keeps the large body from %s %s', (method, url) => {
    expect(isAttributeImportUploadRequest(method, url, admin)).toBe(false);
  });

  it.each([
    ['no headers', {}],
    ['no cookie', { [CSRF_HEADER]: 'token' }],
    ['no CSRF header', { cookie: admin.cookie }],
    ['an empty CSRF header', { cookie: admin.cookie, [CSRF_HEADER]: '' }],
    ['a seller cookie', { cookie: '__Host-session-seller-AU=abc', [CSRF_HEADER]: 'token' }],
  ])('keeps the large body from a request with %s', (_name, headers) => {
    expect(
      isAttributeImportUploadRequest('POST', '/catalog/admin/attribute-imports/check', headers),
    ).toBe(false);
  });
});
