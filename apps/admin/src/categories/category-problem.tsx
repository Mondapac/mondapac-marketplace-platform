'use client';

import { Banner } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { CategoryProblem } from './category-errors.ts';

/** The reason a write was refused, in words. Field problems also show next to their field. */
export function CategoryProblemBanner({ problem }: { readonly problem: CategoryProblem | null }) {
  const t = useTranslations();
  if (problem === null) return null;
  return (
    <Banner tone="critical">
      {problem.values !== undefined
        ? t(problem.key, problem.values)
        : problem.max === undefined
          ? t(problem.key)
          : t(problem.key, { max: problem.max })}
    </Banner>
  );
}
