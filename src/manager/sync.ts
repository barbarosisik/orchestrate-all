/** Small async locks for the run manager (step 12). Nothing here touches the disk. */

/** Runs one piece of work at a time, in the order asked. A failing piece doesn't stop the next. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** One Mutex per key (a repository, a run). */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(key);
    if (lock === undefined) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    return lock.run(work);
  }
}

/** At most `size` holders at once; the others wait in order. */
export class Semaphore {
  private held = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`A semaphore needs a size of 1 or more, not ${size}.`);
  }

  /** Waits for a place, then returns its release function (safe to call more than once). */
  async acquire(): Promise<() => void> {
    if (this.held < this.size) {
      this.held++;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.held--;
    };
  }
}
