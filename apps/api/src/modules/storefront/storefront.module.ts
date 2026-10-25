import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { SellersModule } from '../sellers';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { PAGE_REPOSITORY } from './application/ports/page.repository';
import { LINK_TARGETS } from './application/ports/link-targets';
import { SLIDE_REPOSITORY } from './application/ports/slide.repository';
import { SLIDE_TARGETS } from './application/ports/slide-targets';
import type { StorefrontDependencies } from './application/storefront-dependencies';
import { AddStorefrontModule } from './application/use-cases/add-module.use-case';
import { ApproveStorefrontNavigation } from './application/use-cases/approve-navigation.use-case';
import { ArchiveStorefrontPage } from './application/use-cases/archive-page.use-case';
import { CreateStorefrontPage } from './application/use-cases/create-page.use-case';
import { ListStorefrontPages } from './application/use-cases/list-pages.use-case';
import { PublishStorefrontPage } from './application/use-cases/publish-page.use-case';
import { RemoveStorefrontModule } from './application/use-cases/remove-module.use-case';
import { ReorderStorefrontModules } from './application/use-cases/reorder-modules.use-case';
import { ReplaceStorefrontNavigationDraft } from './application/use-cases/replace-navigation-draft.use-case';
import { RestoreStorefrontNavigationVersion } from './application/use-cases/restore-navigation-version.use-case';
import { RestoreStorefrontPageVersion } from './application/use-cases/restore-page-version.use-case';
import { UpdateStorefrontModule } from './application/use-cases/update-module.use-case';
import { UpdateStorefrontPageSettings } from './application/use-cases/update-page-settings.use-case';
import { ViewStorefrontCatalogue } from './application/use-cases/view-catalogue.use-case';
import { ViewStorefrontNavigation } from './application/use-cases/view-navigation.use-case';
import { ViewStorefrontPage } from './application/use-cases/view-page.use-case';
import { ViewPublishedLandingPage } from './application/use-cases/view-published-landing-page.use-case';
import { ViewPublishedStorefrontNavigation } from './application/use-cases/view-published-navigation.use-case';
import { ViewPublishedStorefrontSlides } from './application/use-cases/view-published-slides.use-case';
import { ViewPublishedStorefrontPage } from './application/use-cases/view-published-page.use-case';
import { ApproveStorefrontSlide } from './application/use-cases/approve-slide.use-case';
import { PauseStorefrontSlide } from './application/use-cases/pause-slide.use-case';
import { ResumeStorefrontSlide } from './application/use-cases/resume-slide.use-case';
import { SubmitStorefrontSlide } from './application/use-cases/submit-slide.use-case';
import { ArchiveStorefrontSlide } from './application/use-cases/archive-slide.use-case';
import { CreateStorefrontSlide } from './application/use-cases/create-slide.use-case';
import { ListStorefrontSlides } from './application/use-cases/list-slides.use-case';
import { PrepareStorefrontSlideCopy } from './application/use-cases/prepare-slide-copy.use-case';
import { RestoreStorefrontSlideVersion } from './application/use-cases/restore-slide-version.use-case';
import { UpdateStorefrontSlideDraft } from './application/use-cases/update-slide-draft.use-case';
import { ViewStorefrontSlide } from './application/use-cases/view-slide.use-case';
import { STOREFRONT_PERMISSIONS } from './contracts';
import { STOREFRONT_AUDIT_ACTIONS } from './domain/audit';
import { storefrontProviders } from './infrastructure/storefront-providers';
import { AdminNavigationController } from './presentation/admin-navigation.controller';
import { AdminSlideController } from './presentation/admin-slide.controller';
import { AdminStorefrontController } from './presentation/admin-storefront.controller';
import { PublicStorefrontController } from './presentation/public-storefront.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: StorefrontDependencies) => U;

const PORTS: readonly [keyof StorefrontDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['pages', PAGE_REPOSITORY],
  ['slides', SLIDE_REPOSITORY],
  ['targets', SLIDE_TARGETS],
  ['links', LINK_TARGETS],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

/** Every storefront use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as StorefrontDependencies,
      ),
  };
}

/**
 * Storefront: the content of the buyer site (content-management analysis, option 2; john 17 Oct).
 * Page templates, their slots and the closed module catalogue are code; admins fill the slots of
 * system pages (home, offers, cart, ...) and of landing pages they create from a template, as a
 * draft that buyers see only once a platform admin publishes it. The navigation (left-rail items,
 * Browse drawer categories) follows the same draft and version flow, approved with its own key.
 * Buyers read the published layouts with no session; product, category and seller data come from
 * their own modules' routes.
 */
@Module({
  imports: [CatalogModule, SellersModule],
  controllers: [
    AdminStorefrontController,
    AdminNavigationController,
    AdminSlideController,
    PublicStorefrontController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('storefront'),
    registerAuditActions('storefront', STOREFRONT_AUDIT_ACTIONS),
    registerPermissions('storefront', STOREFRONT_PERMISSIONS),
    ...storefrontProviders,
    ...[
      AddStorefrontModule,
      ApproveStorefrontNavigation,
      ArchiveStorefrontPage,
      CreateStorefrontPage,
      ListStorefrontPages,
      PublishStorefrontPage,
      RemoveStorefrontModule,
      ReorderStorefrontModules,
      ReplaceStorefrontNavigationDraft,
      RestoreStorefrontNavigationVersion,
      RestoreStorefrontPageVersion,
      UpdateStorefrontModule,
      UpdateStorefrontPageSettings,
      ViewStorefrontCatalogue,
      ViewStorefrontNavigation,
      ViewStorefrontPage,
      ViewPublishedLandingPage,
      ViewPublishedStorefrontNavigation,
      ViewPublishedStorefrontPage,
      ViewPublishedStorefrontSlides,
      ArchiveStorefrontSlide,
      CreateStorefrontSlide,
      ListStorefrontSlides,
      PrepareStorefrontSlideCopy,
      RestoreStorefrontSlideVersion,
      UpdateStorefrontSlideDraft,
      ViewStorefrontSlide,
      ApproveStorefrontSlide,
      PauseStorefrontSlide,
      ResumeStorefrontSlide,
      SubmitStorefrontSlide,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
  ],
})
export class StorefrontModule {}
