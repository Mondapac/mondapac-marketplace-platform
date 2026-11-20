// The reverter port a module of a reviewed area implements, and where it registers it. The port
// lives in platform (so identity, which imports no module, can reach it too: ADR-0018 decision 4);
// system-requests implements the registry, and other modules keep importing it from here.
export {
  CHANGE_IMPACT_LABELS,
  impactItem,
  MAX_DESCRIBE_REFS,
  MAX_IMPACT_COUNT,
  type ChangeImpact,
  type ChangeImpactItem,
  type ChangeImpactLabel,
  registerSystemChangeApplier,
  registerSystemChangeReverter,
  SYSTEM_CHANGE_REVERTERS,
  type ApplyOutcome,
  type RevertOutcome,
  type RevertRequest,
  type SystemChangeApplier,
  type SystemChangeReverter,
  type SystemChangeReverters,
} from '../../../platform/change-review/change-review';
