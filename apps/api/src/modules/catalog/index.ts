// The only entry point other code may import from this module (ADR-0008 decision 6).
export * from './contracts';
export { CatalogModule } from './catalog.module';
export {
  CATALOG_OPERATOR_COMMANDS,
  CATALOG_OPERATOR_USAGE,
} from './presentation/commands/catalog-operator-commands';
