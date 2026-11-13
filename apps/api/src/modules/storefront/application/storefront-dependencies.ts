import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { ChangeTrail } from '../../../platform/audit/change-trail';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { ObjectStore } from '../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { PageRepository } from './ports/page.repository';
import type { LinkTargets } from './ports/link-targets';
import type { SlideImageProcessor } from './ports/slide-image-processor';
import type { SlideImageStore } from './ports/slide-image.store';
import type { SlideRepository } from './ports/slide.repository';
import type { SlideTargets } from './ports/slide-targets';
import type { SeoEnvironment, SeoManageProbe } from './ports/seo-environment';
import type { SeoSettingsRepository } from './ports/seo-settings.repository';

/** What every storefront use case may need; one object built from the same ports. */
export interface StorefrontDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pages: PageRepository;
  readonly slides: SlideRepository;
  readonly targets: SlideTargets;
  /** The slide image library and the shared image pipeline (file storage pilot F9). */
  readonly slideImages: SlideImageStore;
  readonly imageProcessor: SlideImageProcessor;
  readonly objectStore: ObjectStore;
  /** Site paths of link targets (the category tree, the store address of a seller). */
  readonly links: LinkTargets;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** What the SEO settings use cases need (package S1): the unit, audit and clock, and the SEO ports. */
export interface SeoDependencies extends Pick<
  StorefrontDependencies,
  'unitOfWork' | 'audit' | 'clock'
> {
  /** The Market's SEO settings history, the server facts around the indexing switch, and the change trail. */
  readonly seoSettings: SeoSettingsRepository;
  readonly seoEnvironment: SeoEnvironment;
  readonly trail: ChangeTrail;
  readonly outbox: OutboxWriter;
  /** Spends the admin proof of `storefront.seo.change-protected` in the unit of the change. */
  readonly stepUp: StepUpProofConsumer;
  /** Whether the caller holds `storefront.seo.manage` (a restore of a protected field asks). */
  readonly seoManageProbe: SeoManageProbe;
}
