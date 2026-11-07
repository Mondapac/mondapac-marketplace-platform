import {
  isPlatformImportUploadRequest,
  isSellerImportPhotoRequest,
  isSellerImportUploadRequest,
} from '../src/configure-app';

// Which requests get the large raw body parser (catalog design 14c): only the seller import's upload
// and its photo step, only as POST, and never the other routes under the same prefix.

const IMPORT = '01990000-0000-7000-8000-00000000c001';

describe('seller import body routes', () => {
  it('gives the large body to the upload and to the photo step only', () => {
    expect(isSellerImportUploadRequest('POST', '/catalog/seller/imports')).toBe(true);
    expect(isSellerImportUploadRequest('POST', '/catalog/seller/imports/')).toBe(true);
    expect(isSellerImportUploadRequest('POST', '/catalog/seller/imports?x=1')).toBe(true);
    expect(isSellerImportPhotoRequest('POST', `/catalog/seller/imports/${IMPORT}/photos`)).toBe(
      true,
    );
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
    expect(isSellerImportUploadRequest(method, url)).toBe(false);
  });

  it.each([
    ['GET', `/catalog/seller/imports/${IMPORT}/photos`],
    ['POST', '/catalog/seller/imports/not-an-id/photos'],
    ['POST', `/catalog/seller/imports/${IMPORT}/photos/extra`],
    ['POST', '/catalog/seller/imports'],
    ['POST', `/catalog/admin/platform-imports/${IMPORT}/photos`],
  ])('does not give the photo parser to %s %s', (method, url) => {
    expect(isSellerImportPhotoRequest(method, url)).toBe(false);
  });

  it('keeps the admin and seller upload routes apart', () => {
    expect(isPlatformImportUploadRequest('POST', '/catalog/seller/imports')).toBe(false);
    expect(isSellerImportUploadRequest('POST', '/catalog/admin/platform-imports')).toBe(false);
  });
});
