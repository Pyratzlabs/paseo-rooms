import { setTimeout as nodeSetTimeout, clearTimeout } from "node:timers";

const setTimeout = nodeSetTimeout as (
  callback: () => void,
  delay: number,
) => NodeJS.Timeout;
export const RELAY_OUTBOUND_LIMITS = {
  ownerBytes: 256 * 1024,
  ownerFrames: 8,
  queuedBytes: 4 * 1024 * 1024,
  controlBytes: 512 * 1024,
  controlFrames: 64,
  highWaterBytes: 512 * 1024,
  controlBurst: 8,
  stallMs: 30_000,
};
interface Owner {
  id: string;
  queue: Frame[];
  bytes: number;
  queuedBytes: number;
  count: number;
  ready: boolean;
  onOverflow: () => void;
  limit: number;
}
interface Frame {
  data: string;
  bytes: number;
  owner?: Owner;
  key?: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
}
interface OutputTransport {
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
}

/** One physical write at a time; virtual producers retain their own budgets. */
export class RelayOutbound {
  private owners = new Map<string, Owner>();
  private ready: Owner[] = [];
  private controls: Frame[] = [];
  private controlBytes = 0;
  private queuedBytes = 0;
  private burst = 0;
  private flight: Frame | null = null;
  private closed = false;
  private poll: NodeJS.Timeout | null = null;
  private progress: NodeJS.Timeout | null = null;
  constructor(
    private transport: OutputTransport,
    private fatal: (error: Error) => void,
  ) {}
  ownerBytes(id: string): number {
    return this.owners.get(id)?.bytes ?? 0;
  }
  send(
    id: string,
    data: string,
    onOverflow: () => void,
    limit = RELAY_OUTBOUND_LIMITS.ownerBytes,
  ): Promise<void> {
    if (this.closed) return this.rejected();
    const owner = this.owners.get(id) ?? {
      id,
      queue: [],
      bytes: 0,
      queuedBytes: 0,
      count: 0,
      ready: false,
      onOverflow,
      limit,
    };
    this.owners.set(id, owner);
    const frame = this.frame(data, owner);
    if (
      owner.bytes + frame.bytes > owner.limit ||
      owner.count >= RELAY_OUTBOUND_LIMITS.ownerFrames
    ) {
      this.dropOwner(id);
      onOverflow();
      this.settle(frame, new Error("relay producer queue full"));
      return frame.promise;
    }
    owner.queue.push(frame);
    owner.bytes += frame.bytes;
    owner.queuedBytes += frame.bytes;
    owner.count++;
    this.queuedBytes += frame.bytes;
    if (!owner.ready) {
      owner.ready = true;
      this.ready.push(owner);
    }
    while (this.queuedBytes > RELAY_OUTBOUND_LIMITS.queuedBytes) {
      const largest = [...this.owners.values()].reduce<Owner | undefined>(
        (best, value) =>
          value.queuedBytes > (best?.queuedBytes ?? 0) ? value : best,
        undefined,
      );
      if (!largest) break;
      this.dropOwner(largest.id);
      largest.onOverflow();
    }
    this.flush();
    return frame.promise;
  }
  control(data: string, key?: string): Promise<void> {
    if (this.closed) return this.rejected();
    // Only unsent pongs are replaceable; registration and close ordering stays FIFO.
    const previous = key
      ? this.controls.find((frame) => frame.key === key)
      : undefined;
    if (previous) {
      const bytes = Buffer.byteLength(data);
      if (
        this.controlBytes + bytes - previous.bytes >
        RELAY_OUTBOUND_LIMITS.controlBytes
      )
        return this.rejected(new Error("relay control queue full"));
      this.controlBytes += bytes - previous.bytes;
      previous.data = data;
      previous.bytes = Buffer.byteLength(data);
      return previous.promise;
    }
    const frame = this.frame(data);
    frame.key = key;
    if (
      this.controls.length >= RELAY_OUTBOUND_LIMITS.controlFrames ||
      this.controlBytes + frame.bytes > RELAY_OUTBOUND_LIMITS.controlBytes
    ) {
      this.settle(frame, new Error("relay control queue full"));
      return frame.promise;
    }
    this.controls.push(frame);
    this.controlBytes += frame.bytes;
    this.flush();
    return frame.promise;
  }
  dropOwner(id: string): void {
    const owner = this.owners.get(id);
    if (!owner) return;
    this.owners.delete(id);
    owner.ready = false;
    this.ready = this.ready.filter((value) => value !== owner);
    for (const frame of owner.queue) {
      this.queuedBytes -= frame.bytes;
      owner.bytes -= frame.bytes;
      owner.count--;
      this.settle(frame, new Error("relay producer closed"));
    }
    owner.queue = [];
    owner.queuedBytes = 0;
    if (this.flight?.owner === owner)
      this.settle(this.flight, new Error("relay producer closed"));
    this.watchdog();
  }
  close(error = new Error("relay connection closed")): void {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearTimeout(this.poll);
    if (this.progress) clearTimeout(this.progress);
    this.poll = this.progress = null;
    for (const owner of [...this.owners.values()]) this.dropOwner(owner.id);
    for (const frame of this.controls) this.settle(frame, error);
    this.controls = [];
    this.controlBytes = 0;
    if (this.flight) this.settle(this.flight, error);
    this.ready = [];
  }
  private rejected(
    error = new Error("relay connection closed"),
  ): Promise<void> {
    const value = Promise.reject<void>(error);
    void value.catch(() => {});
    return value;
  }
  private frame(data: string, owner?: Owner): Frame {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Legacy fire-and-forget fan-out ignores return values; awaited E2EE callers
    // still receive the original rejection while it never becomes unhandled.
    void promise.catch(() => {});
    return {
      data,
      bytes: Buffer.byteLength(data),
      owner,
      promise,
      resolve,
      reject,
      settled: false,
    };
  }
  private settle(frame: Frame, error?: Error) {
    if (frame.settled) return;
    frame.settled = true;
    if (error) frame.reject(error);
    else frame.resolve();
  }
  private hasWork() {
    return Boolean(this.flight || this.controls.length || this.queuedBytes);
  }
  private watchdog() {
    if (this.closed || !this.hasWork()) {
      if (this.progress) clearTimeout(this.progress);
      this.progress = null;
      return;
    }
    if (!this.progress) {
      this.progress = setTimeout(() => {
        this.progress = null;
        if (this.hasWork()) this.fail(new Error("relay output stalled"));
      }, RELAY_OUTBOUND_LIMITS.stallMs);
      this.progress.unref();
    }
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.close(error);
    this.fatal(error);
  }
  private flush(): void {
    if (this.closed) return;
    this.watchdog();
    if (this.flight || !this.hasWork()) return;
    if (this.transport.bufferedAmount > RELAY_OUTBOUND_LIMITS.highWaterBytes) {
      if (!this.poll) {
        this.poll = setTimeout(() => {
          this.poll = null;
          this.flush();
        }, 10);
        this.poll.unref();
      }
      return;
    }
    while (
      this.ready.length &&
      (!this.ready[0].ready || !this.ready[0].queue.length)
    )
      this.ready.shift();
    let frame: Frame | undefined;
    if (
      this.controls.length &&
      (this.burst < RELAY_OUTBOUND_LIMITS.controlBurst || !this.ready.length)
    ) {
      frame = this.controls.shift()!;
      this.controlBytes -= frame.bytes;
      this.burst++;
    } else {
      const owner = this.ready.shift();
      if (owner) {
        frame = owner.queue.shift()!;
        this.queuedBytes -= frame.bytes;
        owner.queuedBytes -= frame.bytes;
        owner.ready = false;
        if (owner.queue.length) {
          owner.ready = true;
          this.ready.push(owner);
        }
        this.burst = 0;
      }
    }
    if (!frame) {
      this.watchdog();
      return;
    }
    this.flight = frame;
    const sent = frame;
    try {
      this.transport.send(sent.data, (error) => {
        if (this.closed) return;
        this.flight = null;
        if (sent.owner) {
          sent.owner.bytes -= sent.bytes;
          sent.owner.count--;
          if (
            !sent.owner.count &&
            this.owners.get(sent.owner.id) === sent.owner
          )
            this.owners.delete(sent.owner.id);
        }
        this.settle(sent, error);
        if (error) {
          this.fail(error);
          return;
        }
        if (this.progress) clearTimeout(this.progress);
        this.progress = null;
        this.flush();
      });
    } catch (cause) {
      this.fail(
        cause instanceof Error ? cause : new Error("relay write failed"),
      );
    }
  }
}
