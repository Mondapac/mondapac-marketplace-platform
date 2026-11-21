'use client';

import { PagedSuperList as KitPagedSuperList, type PagedListRuntime } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ComponentProps } from 'react';
import { callApi } from '../api/client.ts';

const runtime = { useTranslations, useLocale, callApi } as unknown as PagedListRuntime;

/** The kit's paged super list with the seller panel's translations, locale and relay call. */
export function PagedSuperList<Row>(
  props: Omit<ComponentProps<typeof KitPagedSuperList<Row>>, 'runtime'>,
) {
  return <KitPagedSuperList<Row> {...props} runtime={runtime} />;
}
