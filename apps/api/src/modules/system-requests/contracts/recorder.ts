// The recorder other modules call when an admin changes a reviewed area. The port lives in
// platform (so identity, which imports no module, can reach it too: ADR-0018 decision 4);
// system-requests implements it, and other modules keep importing it from here.
export {
  SYSTEM_REQUEST_RECORDER,
  type AppliedChange,
  type RecordedRequest,
  type RecordFailure,
  type SystemRequestRecorder,
} from '../../../platform/change-review/change-review';
