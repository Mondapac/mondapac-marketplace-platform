import {
  isPlatformImportUploadRequest,
  isSellerImportPhotoRequest,
  isSellerImportUploadRequest,
} from '../src/configure-app';

// Which requests get the large raw body parser (catalog design 14c): only the seller import's upload
// and its photo step, only as POST, and never the other routes under the same prefix.

const IMPORT = '01990000-0000-7000-8000-00000000c001';
// The pre-filter of the store images: a seller session cookie and a CSRF header must be present.
const SELLER = {
  cookie: '__Host-session-seller-AU=abc123',
  'x-csrf-token': 'token',
};

describe('seller import body routes', () => {
  it('gives the large body to the upload and to the photo step only', () => {
    expect(isSellerImportUploadRequest('POST', '/catalog/seller/imports', SELLER)).toBe(true);
    expect(isSellerImportUploadRequest('POST', '/catalog/seller/imports/', SELLER)).toBe(true);
    expect(isSellerImportUploadRequest('POST', '/catalog/seller/imports?x=1', SELLER)).toBe(true);
    expect(
      isSellerImportPhotoRequest('POST', `/catalog/seller/imports/${IMPORT}/photos`, SELLER),
    ).toBe(true);
  });

  it.each([
    ['no cookie and no header', {}],
    ['no cookie', { 'x-csrf-token': 'token' }],
    ['no CSRF header', { cookie: '__Host-session-seller-AU=abc123' }],
    ['an empty CSRF header', { cookie: '__Host-session-seller-AU=abc123', 'x-csrf-token': '' }],
    ['an admin cookie', { cookie: '__Host-session-admin-AU=abc123', 'x-csrf-token': 'token' }],
    ['a customer cookie', { cookie: '__Host-session-customer-AU=abc', 'x-csrf-token': 'token' }],
  ])('keeps the large body from a request with %s', (_label, headers) => {
    expect(isSellerImportUploadRequest('POST', '/catalog/seller/imports', headers)).toBe(false);
    expect(
      isSellerImportPhotoRequest('POST', `/catalog/seller/imports/${IMPORT}/photos`, headers),
    ).toBe(false);
  });

  it.each([
    ['GET', '/catalog/seller/imports'],
    ['PUT', '/catalog/seller/imports'],
    [undefined, '/catalog/seller/imports'],
    ['POST', undefined],
    ['POST', '/catalog/seller/imports/template'],
    ['POST', `/catalog/seller/imports/${IMPORT}/start`],
    ['POST', `/catalog/seller/imports/${IMPORT}/photos`],
    ['POST', '/catalog/seller/imports/extra/path'],
    ['POST', '/catalog/admin/platform-imports'],
  ])('does not give the upload parser to %s %s', (method, url) => {
    expect(isSellerImportUploadRequest(method, url, SELLER)).toBe(false);
  });

  it.each([
    ['GET', `/catalog/seller/imports/${IMPORT}/photos`],
    ['POST', '/catalog/seller/imports/not-an-id/photos'],
    ['POST', `/catalog/seller/imports/${IMPORT}/photos/extra`],
    ['POST', '/catalog/seller/imports'],
    ['POST', `/catalog/admin/platform-imports/${IMPORT}/photos`],
  ])('does not give the photo parser to %s %s', (method, url) => {
    expect(isSellerImportPhotoRequest(method, url, SELLER)).toBe(false);
  });

  it('keeps the admin and seller upload routes apart', () => {
    expect(isPlatformImportUploadRequest('POST', '/catalog/seller/imports')).toBe(false);
    expect(isSellerImportUploadRequest('POST', '/catalog/admin/platform-imports', SELLER)).toBe(
      false,
    );
  });
});
