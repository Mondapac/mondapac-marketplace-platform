import { takesMarketFromPath } from '../../../platform/http/market-from-path.decorator';
import { slideImagePath } from '../application/slide-images/slide-image';
import { PublicSlideImageController } from './public-slide-image.controller';

describe('slide picture route', () => {
  it('takes the Market from the path, because an image request cannot send a header', () => {
    expect(takesMarketFromPath(PublicSlideImageController)).toBe(true);
  });

  it('names the Market in every path the slider read gives', () => {
    const id = '01990000-0000-7000-8000-00000000a001';
    expect(slideImagePath('AU', id, 'desktop')).toBe(`/storefront/slide-images/AU/${id}/desktop`);
    expect(slideImagePath('NZ', id, 'mobile-small')).toBe(
      `/storefront/slide-images/NZ/${id}/mobile-small`,
    );
  });
});
