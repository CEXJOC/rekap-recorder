// SetForegroundWindow fails while another process holds recent user input
// (2026-10-10, on a team PC: the gold and fog keys went elsewhere), so a key
// press counts only when the replay window had the focus.
export const FOCUS_ATTEMPTS = 3;

/** The focus helper's answer: "focused", "focused after Alt" or "not focused (in front: …)". */
export const isFocused = (answer: string) => answer.trim().startsWith("focused");

export type FocusedPress = { ok: boolean; attempts: number; answer: string };

/**
 * Presses until the replay window reports the focus, at most `attempts`
 * times. `beforeRetry` runs after each unfocused press with the helper's
 * answer (e.g. waits until the PC is idle); returning false stops the retries.
 */
export async function pressFocused(
  press: () => Promise<string>,
  beforeRetry: (attempt: number, answer: string) => Promise<boolean>,
  attempts = FOCUS_ATTEMPTS,
): Promise<FocusedPress> {
  for (let attempt = 1; ; attempt++) {
    const answer = (await press()).trim();
    if (isFocused(answer)) return { ok: true, attempts: attempt, answer };
    if (attempt >= attempts || !(await beforeRetry(attempt, answer)))
      return { ok: false, attempts: attempt, answer };
  }
}
