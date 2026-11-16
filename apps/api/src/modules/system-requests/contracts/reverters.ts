// The reverter port a module of a reviewed area implements, and where it registers it. The port
// lives in platform (so identity, which imports no module, can reach it too: ADR-0018 decision 4);
// system-requests implements the registry, and other modules keep importing it from here.
export {
  registerSystemChangeReverter,
  SYSTEM_CHANGE_REVERTERS,
  type RevertOutcome,
  type RevertRequest,
  type SystemChangeReverter,
  type SystemChangeReverters,
} from '../../../platform/change-review/change-review';
