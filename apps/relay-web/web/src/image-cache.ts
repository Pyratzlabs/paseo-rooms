import type { RoomImage } from "../../shared/room-attachments.js";
import type { SecureRoomSession } from "./secure-room-client.js";

/** Session-owned URLs and two lazy pull downloads; never persists media. */
export class RoomImageCache {
  private entries = new Map<string, { url: string; size: number }>();
  private pending = new Map<string, Promise<string>>();
  private jobs: Array<() => void> = [];
  private active = 0;
  private bytes = 0;
  private controller = new AbortController();
  constructor(private session: Pick<SecureRoomSession, "readImage">) {}
  load(image: RoomImage): Promise<string> {
    const cached = this.entries.get(image.id);
    if (cached) {
      this.entries.delete(image.id);
      this.entries.set(image.id, cached);
      return Promise.resolve(cached.url);
    }
    const pending = this.pending.get(image.id);
    if (pending) return pending;
    if (this.controller.signal.aborted || this.jobs.length >= 32)
      return Promise.reject(new Error("image_unavailable"));
    const promise = new Promise<string>((resolve, reject) => {
      const job = () => {
        if (this.controller.signal.aborted) {
          reject(new Error("cancelled"));
          return;
        }
        this.active++;
        void this.session
          .readImage(image, this.controller.signal)
          .then((blob) => {
            if (this.controller.signal.aborted) throw new Error("cancelled");
            while (
              this.bytes + blob.size > 8 * 1024 * 1024 &&
              this.entries.size
            ) {
              const [key, value] = this.entries.entries().next().value!;
              URL.revokeObjectURL(value.url);
              this.entries.delete(key);
              this.bytes -= value.size;
            }
            const url = URL.createObjectURL(blob);
            this.entries.set(image.id, { url, size: blob.size });
            this.bytes += blob.size;
            resolve(url);
          })
          .catch(reject)
          .finally(() => {
            this.pending.delete(image.id);
            this.active--;
            this.jobs.shift()?.();
          });
      };
      if (this.active < 2) job();
      else this.jobs.push(job);
    });
    this.pending.set(image.id, promise);
    return promise;
  }
  invalidate(image: RoomImage): void {
    const value = this.entries.get(image.id);
    if (value) {
      URL.revokeObjectURL(value.url);
      this.bytes -= value.size;
      this.entries.delete(image.id);
    }
  }
  close(): void {
    this.controller.abort();
    for (const value of this.entries.values()) URL.revokeObjectURL(value.url);
    this.entries.clear();
    this.bytes = 0;
    for (const job of this.jobs.splice(0)) job();
  }
}
