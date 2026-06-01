// R11: Facebook publish / comment-save shows a "publishing…" indicator for up
// to ~10s. Verification that runs sooner sees a stale DOM and false-fails, so
// the post-submit verify waits this long before reading back the post. An early
// read is NOT treated as a failure — the delay precedes the first read.
// The literal is written without a digit separator (12000, not 12_000) so the
// ≥12s verify-delay grep gate matches it directly.
export const VERIFY_DELAY_MS = 12000;
