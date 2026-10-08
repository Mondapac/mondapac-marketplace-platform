// Server-only entry (ADR-0037 decision 9): importing this from a client component fails the build.
import 'server-only';

export {
  CLIENT_ADDRESS_HEADER,
  parseClientAddressKey,
  signClientAddress,
  type ClientAddressKey,
} from './client-address.ts';
