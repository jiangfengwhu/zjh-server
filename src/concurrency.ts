/** Serialize mutations of the same resource without holding up unrelated users. */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(operation);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
  runAll<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const enter = (index: number): Promise<T> => index === ordered.length ? operation() : this.run(ordered[index], () => enter(index + 1));
    return enter(0);
  }
}
