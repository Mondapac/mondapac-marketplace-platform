'use client';

import {
  PagedSuperList as KitPagedSuperList,
  pagedQueryString,
  type PagedListRuntime,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ComponentProps } from 'react';
import { callApi } from '../../api/client.ts';

export { pagedQueryString };

const runtime = { useTranslations, useLocale, callApi } as unknown as PagedListRuntime;

/** The kit's paged super list with the admin's translations, locale and relay call. */
export function PagedSuperList<Row>(
  props: Omit<ComponentProps<typeof KitPagedSuperList<Row>>, 'runtime'>,
) {
  return <KitPagedSuperList<Row> {...props} runtime={runtime} />;
}
