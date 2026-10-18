// The port `catalog` implements for certification (design 8.2, request C-3). Declared with the
// module's public contracts, since another module implements it; re-exported here for the use
// cases and providers of this module.
export {
  CATALOG_REFERENCES,
  MAX_CATALOG_REFERENCE_IDS,
  type CatalogReferences,
} from '../../contracts/catalog-references';
