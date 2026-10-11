/**
 * OpenAlgo Charts 2.6 calls AbortController.abort() when tearing down an
 * obsolete grid/history request. Fetch consumers now settle to [], but
 * upstream may still reject a chart-internal, intentionally cancelled task.
 * Only those well-defined AbortError outcomes are non-actionable.
 * NEVER swallow HTTP errors, syntax errors, unexpected promise failures,
 * CSP violations, or real exchange availability failures.
 */
const ABORT_MESSAGES = new Set([
  'signal is aborted without reason',
  'The user aborted a request.',
  'This operation was aborted',
]);

export function isExpectedChartAbort(reason) {
  return reason != null
    && reason.name === 'AbortError'
    && typeof reason.message === 'string'
    && ABORT_MESSAGES.has(reason.message);
}
export function observeChartCancellations(target) {
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  const onRejection = event => {
    if (isExpectedChartAbort(event.reason)) event.preventDefault();
  };
  target.addEventListener('unhandledrejection',onRejection);
  return () => target.removeEventListener('unhandledrejection',onRejection);
}
