/** Bound only connection setup, never the time a person has to approve a transaction. */
export function waitForConnection<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new Error("已取消手機錢包連線。"));
    if (signal.aborted) {
      // Observe late rejections even though this attempt has already been cancelled.
      void pending.catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
