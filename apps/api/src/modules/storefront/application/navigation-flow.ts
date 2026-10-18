import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { at, closedObject, problem, type Problems } from '../domain/fields';
import { addPlacement, type Placements } from '../domain/placements';
import { NAVIGATION_KEY } from '../domain/templates';
import {
  changeDraft,
  publishPage,
  restoreVersion,
  viewPage,
  type PageDetailView,
  type PageFailure,
} from './page-flow';
import type { StorefrontDependencies } from './storefront-dependencies';

// The navigation of the buyer site (john 17 Oct 18:15Z): the left-rail items and the Browse
// drawer's category lists ("Popular & Suggested", "Shop by Category") are chosen by a content
// editor as a draft and are shown only after a platform admin approves it. It is the system page
// `navigation`, so it has the same versions as a page, but its own use cases and keys: editing
// it needs `storefront.navigation.edit`, approving it `storefront.navigation.approve`. The
// "Browse products" button stays first in the rail and the mobile bottom bar stays fixed: they
// are not data.

const MODULE_OF_SLOT: Readonly<Record<string, 'nav-link' | 'nav-category'>> = {
  rail: 'nav-link',
  'drawer-popular': 'nav-category',
  'drawer-categories': 'nav-category',
};

export const viewNavigation = (deps: StorefrontDependencies, context: CallContext) =>
  viewPage(deps, context, { page: NAVIGATION_KEY }, true);

export const approveNavigation = (
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly body: unknown },
) => publishPage(deps, context, { page: NAVIGATION_KEY, body: input?.body }, true);

export const restoreNavigationVersion = (
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly versionId: unknown },
) => restoreVersion(deps, context, { page: NAVIGATION_KEY, versionId: input?.versionId }, true);

/**
 * Replaces the whole navigation draft: `{ slots: { rail: [...], 'drawer-popular': [...],
 * 'drawer-categories': [...] } }`, each entry `{ config, enabled? }` of its slot's module. A
 * missing slot is left empty.
 */
export function replaceNavigationDraft(
  deps: StorefrontDependencies,
  context: CallContext,
  body: unknown,
): Promise<Result<PageDetailView, PageFailure>> {
  const problems: Problems = [];
  if (!closedObject(problems, '', body, ['slots'])) {
    return Promise.resolve(err({ code: 'validation.failed', fields: problems }));
  }
  const slots = body.slots;
  if (!closedObject(problems, 'slots', slots, Object.keys(MODULE_OF_SLOT))) {
    return Promise.resolve(err({ code: 'validation.failed', fields: problems }));
  }
  if (problems.length > 0)
    return Promise.resolve(err({ code: 'validation.failed', fields: problems }));
  return changeDraft(
    deps,
    context,
    NAVIGATION_KEY,
    'replace',
    (template) => {
      let next: Placements = Object.fromEntries(
        Object.keys(MODULE_OF_SLOT).map((key) => [key, []]),
      );
      const found: Problems = [];
      for (const [slotKey, module] of Object.entries(MODULE_OF_SLOT)) {
        const entries = slots[slotKey];
        if (entries === undefined) continue;
        if (!Array.isArray(entries)) {
          problem(found, at('slots', slotKey), 'type');
          continue;
        }
        entries.forEach((entry, index) => {
          const path = at(at('slots', slotKey), index);
          if (!closedObject(found, path, entry, ['config', 'enabled'])) return;
          const added = addPlacement(
            template,
            next,
            slotKey,
            { module, config: entry.config, enabled: entry.enabled },
            deps.ids.next<'StorefrontPlacement'>(),
          );
          if (added.ok) next = added.value;
          else if (added.error.code === 'validation.failed') {
            added.error.fields.forEach((field) =>
              problem(found, `${path}.${field.path}`, field.code),
            );
          } else problem(found, at('slots', slotKey), 'count');
        });
      }
      return found.length > 0
        ? { ok: false, error: { code: 'validation.failed', fields: found } }
        : { ok: true, value: next, module: null };
    },
    true,
  );
}
