const MIN = parseInt(process.env.RESPONSE_DELAY_MIN_MINUTES ?? '1', 10);
const MAX = parseInt(process.env.RESPONSE_DELAY_MAX_MINUTES ?? '15', 10);

/**
 * Returns a random delay in minutes between MIN and MAX (inclusive).
 */
export function randomDelayMinutes(): number {
  return Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
}

/**
 * Returns a Date offset from now by the given number of minutes.
 */
export function scheduledFor(delayMinutes: number): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() + delayMinutes);
  return d;
}
