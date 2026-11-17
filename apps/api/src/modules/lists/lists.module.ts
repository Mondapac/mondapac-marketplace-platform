import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { AUTHORISATION_CHECK, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IdentityModule } from '../identity';
import { ListRegistry } from './application/saved-filter-shared';
import { SavedFilterCreate } from './application/use-cases/saved-filter-create.use-case';
import { SavedFilterDelete } from './application/use-cases/saved-filter-delete.use-case';
import { SavedFilterUpdate } from './application/use-cases/saved-filter-update.use-case';
import { SavedFiltersList } from './application/use-cases/saved-filters-list.use-case';
import { SavedFiltersReorder } from './application/use-cases/saved-filters-reorder.use-case';
import { LIST_REGISTRATION, SAVED_FILTER_STORE } from './contracts';
import { LISTS_AUDIT_ACTIONS } from './domain/audit';
import { listsProviders } from './infrastructure/lists-providers';
import { AdminSavedFilterController } from './presentation/saved-filter.controller';

const PORTS: Readonly<Record<string, InjectionToken>> = {
  unitOfWork: UNIT_OF_WORK,
  store: SAVED_FILTER_STORE,
  registry: ListRegistry,
  authorisation: AUTHORISATION_CHECK,
  audit: AUDIT_WRITER,
  clock: CLOCK,
  ids: ID_GENERATOR,
};

/** A use case built from the named ports it declares in `ports`. */
function useCaseProvider<D, U>(
  type: new (gate: UseCaseGate, deps: D) => U,
  ports: readonly (keyof D & string)[],
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...ports.map((name) => PORTS[name] as InjectionToken)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(gate, Object.fromEntries(ports.map((name, index) => [name, values[index]])) as D),
  };
}

/**
 * Lists: the shared kit of the super lists (phase 0). It owns the one table of saved filters in
 * the `lists` schema and the generic routes over it; the module that owns a list keeps the
 * meaning of its filters and the keys that guard it, and registers the list with
 * `registerLists` (see `contracts`). The table is reached only through {@link SAVED_FILTER_STORE}.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AdminSavedFilterController],
  providers: [
    PersistenceModule.auditWriterFor('lists'),
    registerAuditActions('lists', LISTS_AUDIT_ACTIONS),
    ...listsProviders,
    ListRegistry,
    { provide: LIST_REGISTRATION, useExisting: ListRegistry },
    useCaseProvider(SavedFiltersList, ['unitOfWork', 'store', 'registry', 'authorisation']),
    useCaseProvider(SavedFilterCreate, [
      'unitOfWork',
      'store',
      'registry',
      'authorisation',
      'audit',
      'clock',
      'ids',
    ]),
    useCaseProvider(SavedFilterUpdate, [
      'unitOfWork',
      'store',
      'registry',
      'authorisation',
      'audit',
      'clock',
    ]),
    useCaseProvider(SavedFilterDelete, [
      'unitOfWork',
      'store',
      'registry',
      'authorisation',
      'audit',
    ]),
    useCaseProvider(SavedFiltersReorder, ['unitOfWork', 'store', 'registry', 'authorisation']),
  ],
  exports: [SAVED_FILTER_STORE, LIST_REGISTRATION],
})
export class ListsModule {}
