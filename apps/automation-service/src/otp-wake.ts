/** In-process wake for waitForOtp when API notifies OTP submit (backup to Redis pub/sub). */
const waiters = new Map<string, Set<() => void>>();

export function registerOtpWake(runId: string, wake: () => void): () => void {
  let set = waiters.get(runId);
  if (!set) {
    set = new Set();
    waiters.set(runId, set);
  }
  set.add(wake);
  return () => {
    set?.delete(wake);
    if (set?.size === 0) waiters.delete(runId);
  };
}

export function notifyOtpWake(runId: string): void {
  const set = waiters.get(runId);
  if (!set) return;
  for (const wake of set) wake();
}
