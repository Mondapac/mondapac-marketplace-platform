import { isAttributeImportUploadRequest } from '../src/configure-app';

// Which requests get the large raw body parser for the attribute import (attributes package A9):
// only the check and the run, only as POST, and never the other routes under the same prefix.

describe('attribute import body routes', () => {
  it.each([
    '/catalog/admin/attribute-imports/check',
    '/catalog/admin/attribute-imports/run/',
    '/catalog/admin/attribute-imports/check?x=1',
  ])('gives the large body to POST %s', (url) => {
    expect(isAttributeImportUploadRequest('POST', url)).toBe(true);
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
    expect(isAttributeImportUploadRequest(method, url)).toBe(false);
  });
});
