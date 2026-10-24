import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { StoreImageRef } from '../../domain/store-image';
import type {
  AccessUnavailable,
  DraftAccessDenied,
  RequestThrottled,
  SellerActor,
  SellersUnavailable,
} from '../draft/draft-support';
import type { DraftConflict, DraftValidationFailed, FileNotFound } from '../draft/draft-view';
import type { StoreImageRepository } from '../ports/store-image.repository';
import type { StoreProfileContentRepository } from '../ports/store-profile-content.repository';
import type { StoreProfileContentSealer } from '../ports/store-profile-content-sealer';
import type { StoreProfileLocalesPolicy } from '../ports/store-profile-locales';
import type { StoreProfileRepository } from '../ports/store-profile.repository';

// What the use cases of the seller's own store profile share (sellers design 3.7, 6.2; slice 12
// part 2): the view, the failures, and the one read behind the page and behind every save's answer.
// The seller is always `ActorContext.sellerId`, never an id from the request.

/** What the Store profile page shows: the texts, the images and the version a text save names. */
export interface StoreProfileView {
  /** The number of the published revision (0: nothing saved yet); `expectedVersion` of a save. */
  readonly version: number;
  /** The About text of every locale the Market offers; an empty string where none is written. */
  readonly about: Readonly<Record<string, string>>;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly logo: StoreImageRef | null;
  readonly banner: StoreImageRef | null;
}

export type StoreProfileFailure =
  DraftAccessDenied | AccessUnavailable | SellersUnavailable | FileNotFound;

export type StoreProfileWriteFailure =
  StoreProfileFailure | DraftValidationFailed | RequestThrottled | DraftConflict;

export interface StoreProfileReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly storeProfiles: StoreProfileRepository;
  readonly storeContent: StoreProfileContentRepository;
  readonly storeImages: StoreImageRepository;
  readonly contentSealer: StoreProfileContentSealer;
  readonly localesPolicy: StoreProfileLocalesPolicy;
}

export const storeProfileLogger = new Logger('SellerStoreProfile');

/**
 * Reads the seller's own store profile: the settings row (a seller whose file is not approved is
 * `access.denied`, no row is `file.not-found`), the published pointer, the sealed content and the
 * current images in one read-only unit; then the content is opened outside it. A destroyed key (an
 * erased seller) reads as no text. Any other fault is logged and answers `sellers.unavailable`:
 * there is no partial answer.
 */
export async function loadStoreProfileView(
  deps: StoreProfileReadDependencies,
  context: CallContext,
  owner: SellerActor,
): Promise<Result<StoreProfileView, StoreProfileFailure>> {
  const { market } = context;
  try {
    const locales = deps.localesPolicy.locales(market);
    const read = await deps.unitOfWork.run<
      {
        revisionNo: number;
        sealed: Awaited<ReturnType<StoreProfileContentRepository['content']>>;
        images: Awaited<ReturnType<StoreImageRepository['currentOf']>>;
      },
      StoreProfileFailure
    >(
      market,
      async () => {
        const settings = await deps.storeProfiles.find(market, owner.sellerId);
        if (settings === null) return err({ code: 'file.not-found' });
        if (!settings.approved) return err({ code: 'access.denied' });
        const published = await deps.storeContent.published(market, owner.sellerId);
        return ok({
          revisionNo: published?.revisionNo ?? 0,
          sealed:
            published === null
              ? null
              : await deps.storeContent.content(market, owner.sellerId, published.revisionId),
          images: await deps.storeImages.currentOf(market, owner.sellerId),
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return read;
    const about: Record<string, string> = Object.fromEntries(
      locales.supportedLocales.map((locale) => [locale, '']),
    );
    if (read.value.sealed !== null) {
      const opened = await deps.contentSealer.open(market, owner.sellerId, read.value.sealed);
      if (opened.ok) {
        for (const [locale, text] of Object.entries(opened.value.about)) {
          if (locale in about) about[locale] = text;
        }
      } else if (opened.error.code !== 'subject-key.destroyed') {
        storeProfileLogger.error({
          msg: 'sellers.store-profile.content-unreadable',
          code: opened.error.code,
          sellerId: owner.sellerId,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return err({ code: 'sellers.unavailable' });
      }
    }
    const ref = (kind: 'logo' | 'banner'): StoreImageRef | null => {
      const found = read.value.images.find((image) => image.kind === kind);
      return found === undefined
        ? null
        : { id: found.id, width: found.width, height: found.height };
    };
    return ok({
      version: read.value.revisionNo,
      about,
      defaultLocale: locales.defaultLocale,
      locales: locales.supportedLocales,
      logo: ref('logo'),
      banner: ref('banner'),
    });
  } catch (error) {
    storeProfileLogger.error({
      msg: 'sellers.store-profile.read-failed',
      error: error instanceof Error ? error.name : 'unknown',
      sellerId: owner.sellerId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'sellers.unavailable' });
  }
}
