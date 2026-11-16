import { Module } from '@nestjs/common';
import { SAVED_FILTER_STORE } from './contracts';
import { listsProviders } from './infrastructure/lists-providers';

/**
 * Lists: the shared kit of the super lists (phase 0). It owns the one table of saved filters in
 * the `lists` schema; the module that owns a list keeps the meaning of its filters and the rules of
 * who may do what, and reaches the table only through {@link SAVED_FILTER_STORE}.
 */
@Module({
  providers: [...listsProviders],
  exports: [SAVED_FILTER_STORE],
})
export class ListsModule {}
