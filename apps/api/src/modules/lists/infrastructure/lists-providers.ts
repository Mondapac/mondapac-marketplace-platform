import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  COLUMN_PREFERENCE_STORE,
  SAVED_FILTER_STORE,
  type ColumnPreferenceStore,
  type SavedFilterStore,
} from '../contracts';
import { PrismaColumnPreferenceStore } from './prisma-column-preference-store';
import { PrismaSavedFilterStore } from './prisma-saved-filter-store';

/** Binds the ports of lists. Only this layer may reach `PrismaService`. */
export const listsProviders: readonly FactoryProvider[] = [
  {
    provide: SAVED_FILTER_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SavedFilterStore => new PrismaSavedFilterStore(prisma),
  },
  {
    provide: COLUMN_PREFERENCE_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ColumnPreferenceStore =>
      new PrismaColumnPreferenceStore(prisma),
  },
];
