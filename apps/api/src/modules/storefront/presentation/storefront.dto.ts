import { ApiProperty } from '@nestjs/swagger';
import type { Temporal } from '@mondapac/shared-kernel';
import type { PageSummaryView } from '../application/use-cases/list-pages.use-case';
import type { CatalogueView } from '../application/use-cases/view-catalogue.use-case';
import type { PageDetailView } from '../application/use-cases/view-page.use-case';
import type { PublishedAnswer } from '../application/use-cases/view-published-page.use-case';
import type { Placements } from '../domain/placements';

// Bodies of the storefront routes. Module settings are data (plain texts, ids, site paths and
// ready-made image keys); the buyer app renders every text as text.

const instant = (value: Temporal.Instant | null): string | null =>
  value === null ? null : value.toString();

const SLOT_DESCRIPTION =
  'Slots of the template in order: { key, kind: modules | fixed, modules (allowed), min, max, width }.';
const PLACEMENTS_DESCRIPTION =
  'Per slot key, the ordered modules: { id, module, enabled, config }. Disabled modules are never served.';

export class PageSummaryBody {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'null: a system page never changed.',
  })
  id!: string | null;
  @ApiProperty({ enum: ['system', 'dynamic'] }) kind!: string;
  @ApiProperty({ nullable: true, type: String }) systemKey!: string | null;
  @ApiProperty({ nullable: true, type: String }) slug!: string | null;
  @ApiProperty({ description: 'The buyer-site path.' }) path!: string;
  @ApiProperty() templateKey!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: ['full', 'limited', 'locked', 'navigation'] }) editLevel!: string;
  @ApiProperty({ enum: ['default', 'draft', 'scheduled', 'published', 'ended', 'archived'] })
  status!: string;
  @ApiProperty() hasDraft!: boolean;
  @ApiProperty({ nullable: true, type: Number }) publishedVersionNo!: number | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) publishedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) updatedAt!: string | null;
}

export class PageListBody {
  @ApiProperty({
    type: [PageSummaryBody],
    description: 'System pages first, then dynamic pages, newest first.',
  })
  pages!: PageSummaryBody[];
}

export class PageDetailBody extends PageSummaryBody {
  @ApiProperty({ type: Object, description: '{ title?, description?, image?: { ref, alt } }' })
  seo!: object;
  @ApiProperty({
    type: Object,
    nullable: true,
    description: '{ type: category | product | seller, id }',
  })
  linked!: object | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) startsAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) endsAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) archivedRedirect!: string | null;
  @ApiProperty({ type: [Object], description: SLOT_DESCRIPTION }) slots!: object[];
  @ApiProperty({
    type: Object,
    description: `{ versionNo (null: not created yet; what a new draft starts from), placements, updatedAt }. ${PLACEMENTS_DESCRIPTION}`,
  })
  draft!: object;
  @ApiProperty({ type: Object, nullable: true, description: '{ versionNo, placements }' })
  published!: object | null;
  @ApiProperty({
    type: [Object],
    description: '{ id, versionNo, state, createdAt, publishedAt }, newest first.',
  })
  versions!: object[];
}

export class CatalogueBody {
  @ApiProperty({ type: [Object], description: '{ key, scope: dynamic | system, linkable, slots }' })
  templates!: object[];
  @ApiProperty({ type: [Object], description: '{ key, fields }: the closed module catalogue.' })
  modules!: object[];
  @ApiProperty({ type: [Object], description: '{ key, templateKey, editLevel, path }' })
  systemPages!: object[];
}

export class PublishedBody {
  @ApiProperty({ enum: ['page', 'redirect'] }) kind!: string;
  @ApiProperty({
    type: Object,
    required: false,
    description:
      'kind page: { kind, key, slug, templateKey, title, seo, linked, versionNo (null: defaults), publishedAt, slots: [{ key, kind, width, modules: [{ id, module, config }] }] }',
  })
  page?: object;
  @ApiProperty({ required: false, description: 'kind redirect: the site path to go to.' })
  to?: string;
}

export class NewPageRequest {
  @ApiProperty({ enum: ['campaign-landing', 'brand-page', 'product-spotlight', 'info-page'] })
  templateKey!: string;
  @ApiProperty({ example: 'Ramadan specials' }) title!: string;
  @ApiProperty({ example: 'ramadan-specials', description: 'Served at /l/<slug>.' }) slug!: string;
  @ApiProperty({ required: false, type: Object }) seo?: object;
  @ApiProperty({ required: false, type: Object, nullable: true }) linked?: object | null;
  @ApiProperty({ required: false, format: 'date-time', nullable: true, type: String }) startsAt?:
    string | null;
  @ApiProperty({ required: false, format: 'date-time', nullable: true, type: String }) endsAt?:
    string | null;
}

export class AddModuleRequest {
  @ApiProperty({ description: 'A module the slot allows.' }) module!: string;
  @ApiProperty({ type: Object, description: "The module's settings (see the catalogue)." })
  config!: object;
  @ApiProperty({ required: false, description: '0-based; absent: at the end.' }) position?: number;
  @ApiProperty({ required: false, default: true }) enabled?: boolean;
}

export class UpdateModuleRequest {
  @ApiProperty({ required: false, type: Object }) config?: object;
  @ApiProperty({ required: false }) enabled?: boolean;
}

export class ReorderRequest {
  @ApiProperty({
    type: [String],
    description: 'Every placement id of the slot, once, in the new order.',
  })
  placementIds!: string[];
}

export class RestoreRequest {
  @ApiProperty({ format: 'uuid' }) versionId!: string;
}

export class ArchiveRequest {
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'A site path; null: the URL is gone.',
  })
  redirectTo?: string | null;
}

export class NavigationDraftRequest {
  @ApiProperty({
    type: Object,
    description:
      "{ rail?: [{ config: nav-link, enabled? }], 'drawer-popular'?: [{ config: nav-category, enabled? }], 'drawer-categories'?: [...] }",
  })
  slots!: object;
}

const placementsBody = (placements: Placements) =>
  Object.fromEntries(
    Object.entries(placements).map(([key, list]) => [
      key,
      list.map((entry) => ({
        id: entry.id,
        module: entry.module,
        enabled: entry.enabled,
        config: entry.config,
      })),
    ]),
  );

export const summaryBody = (view: PageSummaryView): PageSummaryBody => ({
  id: view.id,
  kind: view.kind,
  systemKey: view.systemKey,
  slug: view.slug,
  path: view.path,
  templateKey: view.templateKey,
  title: view.title,
  editLevel: view.editLevel,
  status: view.status,
  hasDraft: view.hasDraft,
  publishedVersionNo: view.publishedVersionNo,
  publishedAt: instant(view.publishedAt),
  updatedAt: instant(view.updatedAt),
});

export const detailBody = (view: PageDetailView): PageDetailBody => ({
  ...summaryBody(view),
  seo: view.seo,
  linked: view.linked,
  startsAt: instant(view.startsAt),
  endsAt: instant(view.endsAt),
  archivedRedirect: view.archivedRedirect,
  slots: view.slots.map((slot) => ({ ...slot })),
  draft: {
    versionNo: view.draft.versionNo,
    placements: placementsBody(view.draft.placements),
    updatedAt: instant(view.draft.updatedAt),
  },
  published:
    view.published === null
      ? null
      : {
          versionNo: view.published.versionNo,
          placements: placementsBody(view.published.placements),
        },
  versions: view.versions.map((version) => ({
    id: version.id,
    versionNo: version.versionNo,
    state: version.state,
    createdAt: version.createdAt.toString(),
    publishedAt: instant(version.publishedAt),
  })),
});

export const catalogueBody = (view: CatalogueView): CatalogueBody => ({
  templates: view.templates.map((template) => ({ ...template })),
  modules: view.modules.map((module) => ({ ...module })),
  systemPages: view.systemPages.map((page) => ({ ...page })),
});

export const publishedBody = (answer: PublishedAnswer): PublishedBody =>
  answer.kind === 'redirect'
    ? { kind: 'redirect', to: answer.to }
    : {
        kind: 'page',
        page: {
          ...answer.page,
          publishedAt: instant(answer.page.publishedAt),
          slots: answer.page.slots.map((slot) => ({ ...slot })),
        },
      };
