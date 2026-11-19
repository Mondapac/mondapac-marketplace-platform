// The reverter port a module of a reviewed area implements, and where it registers it. The port
// lives in platform (so identity, which imports no module, can reach it too: ADR-0018 decision 4);
// system-requests implements the registry, and other modules keep importing it from here.
export {
  MAX_DESCRIBE_REFS,
  createSystemChangeRegistrar,
  SYSTEM_CHANGE_REVERTERS,
  type ApplyOutcome,
  type RevertOutcome,
  type RevertRequest,
  type SystemChangeApplier,
  type SystemChangeRegistrar,
  type SystemChangeReverter,
  type SystemChangeReverters,
} from '../../../platform/change-review/change-review';
