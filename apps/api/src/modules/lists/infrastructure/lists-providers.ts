import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { SAVED_FILTER_STORE, type SavedFilterStore } from '../contracts';
import { PrismaSavedFilterStore } from './prisma-saved-filter-store';

/** Binds the ports of lists. Only this layer may reach `PrismaService`. */
export const listsProviders: readonly FactoryProvider[] = [
  {
    provide: SAVED_FILTER_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SavedFilterStore => new PrismaSavedFilterStore(prisma),
  },
];
