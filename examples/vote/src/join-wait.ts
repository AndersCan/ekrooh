/** Seconds since a successful Join while no other device has connected. */
export function createJoinWait(now: () => number = Date.now) {
  let joinedAt: number | undefined;
  return {
    /** Starts the wait only when the join worked. */
    joined(ok: boolean) {
      if (ok) joinedAt = now();
    },
    seconds(connected: number): number | undefined {
      if (connected > 0) joinedAt = undefined;
      if (joinedAt === undefined) return undefined;
      return Math.floor((now() - joinedAt) / 1000);
    },
  };
}

/** Clears the box only when the join worked, so a bad code stays to fix. */
export async function submitJoin(
  input: { value: string },
  join: (code: string) => Promise<boolean>,
): Promise<void> {
  if (await join(input.value)) input.value = '';
}
