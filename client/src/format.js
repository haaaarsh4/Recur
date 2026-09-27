// Durations from the local runtime are recorded with sub-millisecond precision,
// so a value that rounds to zero is shown as "<1ms": the program really did run
// here, it just finished faster than a millisecond can describe.
export function formatMs(value) {
  if (value == null || Number.isNaN(Number(value))) return "local";
  const ms = Number(value);
  if (ms < 1) return "<1ms";
  return `${Math.round(ms)}ms`;
}
