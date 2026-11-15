import type { PermissionKey } from '../../../platform/authz';
import {
  SYSTEM_REQUESTS_CATALOGUE_REVIEW,
  SYSTEM_REQUESTS_CERTIFICATION_REVIEW,
  SYSTEM_REQUESTS_CONTENT_REVIEW,
  SYSTEM_REQUESTS_DELIVERY_REVIEW,
  SYSTEM_REQUESTS_MARKETPLACE_REVIEW,
  SYSTEM_REQUESTS_MONEY_REVIEW,
  SYSTEM_REQUESTS_PEOPLE_REVIEW,
} from '../contracts/permissions';
import type { ReviewArea } from '../domain/areas';

/**
 * The key an admin needs to approve or reject a request of the area. The review policy is
 * reviewed by the people reviewers (it decides who reviews what).
 */
export const REVIEW_KEYS: Readonly<Record<ReviewArea, PermissionKey>> = Object.freeze({
  people: SYSTEM_REQUESTS_PEOPLE_REVIEW.key,
  money: SYSTEM_REQUESTS_MONEY_REVIEW.key,
  delivery: SYSTEM_REQUESTS_DELIVERY_REVIEW.key,
  catalogue: SYSTEM_REQUESTS_CATALOGUE_REVIEW.key,
  certification: SYSTEM_REQUESTS_CERTIFICATION_REVIEW.key,
  marketplace: SYSTEM_REQUESTS_MARKETPLACE_REVIEW.key,
  content: SYSTEM_REQUESTS_CONTENT_REVIEW.key,
  'review-policy': SYSTEM_REQUESTS_PEOPLE_REVIEW.key,
});
