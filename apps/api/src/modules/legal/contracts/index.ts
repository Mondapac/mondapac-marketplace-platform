// Public contracts of the legal module (ADR-0008): the facade interface and its token. No
// permission keys: every customer use case is `own-resources`. Other modules may import only what
// this file exports, through ../index.ts.
export { LEGAL_FACADE, type LegalFacade } from './legal.facade';
