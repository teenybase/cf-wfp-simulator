/**
 * Wire-format header names shared by the wrap and the sim. The generated outbound
 * bridge + per-tenant wrapper templates (see outbound.ts) re-declare the
 * `x-wfp-outbound` literal inline; keep it in sync with HEADER_OUTBOUND here.
 * All lowercase to match Node's incoming-headers normalization.
 */
export const WFP_HEADER_PREFIX = 'x-wfp-';
export const HEADER_NOT_FOUND = 'x-wfp-not-found';
export const HEADER_OUTBOUND = 'x-wfp-outbound';
export const HEADER_ORIGINAL_URL = 'x-wfp-original-url';
