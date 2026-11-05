/**
 * Wraps a log sink that can fire once per audio packet, so that a message
 * repeating at packet rate is written once and then at most once per interval.
 *
 * A packet sender only has something to say when a send fails, but once a
 * device drops off the network every packet fails: ~86 identical lines a
 * second, which is itself enough load to stall the event loop the audio runs
 * on. `repeats` counts the lines held back since the last one written.
 */
export function collapseRepeats(
  write: (message: string, repeats: number) => void,
  intervalMs = 1000,
  now: () => number = Date.now,
): (message: string) => void {
  let last: string | undefined;
  let lastAt = 0;
  let held = 0;
  return (message) => {
    const at = now();
    if (message === last && at - lastAt < intervalMs) {
      held += 1;
      return;
    }
    const repeats = held;
    last = message;
    lastAt = at;
    held = 0;
    write(message, repeats);
  };
}
