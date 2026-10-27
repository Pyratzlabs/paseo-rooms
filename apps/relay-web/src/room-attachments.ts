import crypto from "node:crypto";
import { setInterval as nodeSetInterval } from "node:timers";
import { getSecureRoom, type SecureRoom } from "./rooms.js";
import { validateImage } from "./image-validation.js";
import {
  IMAGE_CHUNK_BYTES,
  MAX_IMAGE_BYTES,
  isImageMime,
  isObject,
  validId,
  type RoomImage,
  type SubmissionReceipt,
  type UploadedImage,
} from "../shared/room-attachments.js";

export const ATTACHMENT_LIMITS = {
  roomBytes: 32 * 1024 * 1024,
  globalBytes: 128 * 1024 * 1024,
  roomImages: 128,
  globalImages: 512,
  roomUploads: 4,
  globalUploads: 16,
  roomReceipts: 128,
  globalReceipts: 512,
  idleMs: 60_000,
  absoluteMs: 300_000,
  sendMs: 15_000,
};
interface Asset {
  image: RoomImage;
  bytes: Buffer;
  capability: string;
  owner: string;
  offset: number;
  finished: boolean;
  committed: boolean;
  created: number;
  touched: number;
}
interface Receipt extends SubmissionReceipt {
  fingerprint: string;
  imageId?: string;
}
interface State {
  room: SecureRoom;
  alive: boolean;
  assets: Map<string, Asset>;
  receipts: Map<string, Receipt>;
  associations: Map<string, string>;
  dispatch: { cancel(): void } | null;
}
const states = new Map<string, State>();
let totalBytes = 0,
  totalImages = 0,
  totalUploads = 0,
  totalReceipts = 0,
  activeSends = 0;
const id = () => crypto.randomBytes(24).toString("base64url");
function error(code: string): never {
  throw new Error(code);
}
function state(room: SecureRoom): State {
  if (getSecureRoom(room.token) !== room) error("room_closed");
  let value = states.get(room.token);
  if (!value) {
    value = {
      room,
      alive: true,
      assets: new Map(),
      receipts: new Map(),
      associations: new Map(),
      dispatch: null,
    };
    states.set(room.token, value);
  }
  if (!value.alive || value.room !== room) error("room_closed");
  return value;
}
function release(s: State, a: Asset) {
  if (!s.assets.delete(a.image.id)) return;
  totalBytes -= a.image.byteLength;
  totalImages--;
  if (!a.finished) totalUploads--;
}
function owned(s: State, owner: string, payload: unknown): Asset {
  if (
    !isObject(payload) ||
    !validId(payload.imageId) ||
    !validId(payload.capability)
  )
    error("invalid_image_request");
  const a = s.assets.get(payload.imageId);
  if (
    !a ||
    a.owner !== owner ||
    a.capability !== payload.capability ||
    a.committed
  )
    error("image_unavailable");
  return a;
}
export function expireAttachments(now = Date.now()): void {
  for (const s of states.values())
    for (const a of s.assets.values())
      if (
        !a.committed &&
        (now - a.touched > ATTACHMENT_LIMITS.idleMs ||
          now - a.created > ATTACHMENT_LIMITS.absoluteMs)
      )
        release(s, a);
}
// React Native contributes browser timer overloads when the plugin workspace
// typechecks this Node service. Keep this timer on the Node runtime contract.
const setInterval = nodeSetInterval as (
  callback: () => void,
  delay: number,
) => NodeJS.Timeout;
const expiration = setInterval(expireAttachments, 15_000);
expiration.unref();
export function deleteRoomAttachments(token: string): void {
  const s = states.get(token);
  if (!s) return;
  s.alive = false;
  s.dispatch?.cancel();
  for (const a of s.assets.values()) release(s, a);
  totalReceipts -= s.receipts.size;
  s.receipts.clear();
  s.associations.clear();
  states.delete(token);
}
export function disconnectAttachments(room: SecureRoom, owner: string): void {
  const s = states.get(room.token);
  if (!s || s.room !== room) return;
  for (const a of s.assets.values())
    if (a.owner === owner && !a.committed) release(s, a);
}
export function beginImage(room: SecureRoom, owner: string, payload: unknown) {
  expireAttachments();
  const s = state(room);
  if (
    !isObject(payload) ||
    !isImageMime(payload.mimeType) ||
    !Number.isSafeInteger(payload.byteLength) ||
    Number(payload.byteLength) < 1 ||
    Number(payload.byteLength) > MAX_IMAGE_BYTES
  )
    error("invalid_image_request");
  const byteLength = Number(payload.byteLength);
  const uploads = [...s.assets.values()].filter((a) => !a.finished);
  if ([...s.assets.values()].some((a) => a.owner === owner && !a.committed))
    error("upload_busy");
  if (
    uploads.length >= ATTACHMENT_LIMITS.roomUploads ||
    totalUploads >= ATTACHMENT_LIMITS.globalUploads
  )
    error("upload_busy");
  const roomBytes = [...s.assets.values()].reduce(
    (sum, a) => sum + a.image.byteLength,
    0,
  );
  if (
    roomBytes + byteLength > ATTACHMENT_LIMITS.roomBytes ||
    totalBytes + byteLength > ATTACHMENT_LIMITS.globalBytes ||
    s.assets.size >= ATTACHMENT_LIMITS.roomImages ||
    totalImages >= ATTACHMENT_LIMITS.globalImages
  )
    error("room_full");
  // Reserve before allocating. Transient base64 copies are limited to one 24KiB
  // chunk per ordered client operation; SDK copies are limited to two sends.
  totalBytes += byteLength;
  totalImages++;
  totalUploads++;
  const image: RoomImage = {
    id: id(),
    mimeType: payload.mimeType,
    byteLength,
    width: 0,
    height: 0,
  };
  const capability = id();
  try {
    s.assets.set(image.id, {
      image,
      bytes: Buffer.alloc(byteLength),
      capability,
      owner,
      offset: 0,
      finished: false,
      committed: false,
      created: Date.now(),
      touched: Date.now(),
    });
  } catch {
    totalBytes -= byteLength;
    totalImages--;
    totalUploads--;
    error("room_full");
  }
  return { imageId: image.id, capability };
}
export function appendImage(room: SecureRoom, owner: string, payload: unknown) {
  const s = state(room),
    a = owned(s, owner, payload);
  try {
    if (
      !isObject(payload) ||
      a.finished ||
      payload.offset !== a.offset ||
      typeof payload.data !== "string" ||
      payload.data.length < 4 ||
      payload.data.length > (IMAGE_CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        payload.data,
      )
    )
      error("invalid_chunk");
    const bytes = Buffer.from(payload.data, "base64");
    if (
      !bytes.length ||
      bytes.length > IMAGE_CHUNK_BYTES ||
      bytes.toString("base64") !== payload.data ||
      a.offset + bytes.length > a.image.byteLength ||
      (a.offset + bytes.length < a.image.byteLength &&
        bytes.length !== IMAGE_CHUNK_BYTES)
    )
      error("invalid_chunk");
    bytes.copy(a.bytes, a.offset);
    a.offset += bytes.length;
    a.touched = Date.now();
    return { offset: a.offset };
  } catch (cause) {
    release(s, a);
    throw cause;
  }
}
export function finishImage(
  room: SecureRoom,
  owner: string,
  payload: unknown,
): UploadedImage {
  const s = state(room),
    a = owned(s, owner, payload);
  try {
    if (a.finished || a.offset !== a.image.byteLength)
      error("incomplete_image");
    Object.assign(a.image, validateImage(a.bytes, a.image.mimeType));
    a.finished = true;
    totalUploads--;
    a.touched = Date.now();
    return { image: { ...a.image }, capability: a.capability };
  } catch (cause) {
    release(s, a);
    throw cause;
  }
}
export function cancelImage(room: SecureRoom, owner: string, payload: unknown) {
  const s = state(room),
    a = owned(s, owner, payload);
  release(s, a);
  return {};
}
export function readImage(room: SecureRoom, payload: unknown) {
  const s = state(room);
  if (
    !isObject(payload) ||
    !validId(payload.imageId) ||
    !Number.isSafeInteger(payload.offset) ||
    Number(payload.offset) < 0 ||
    Number(payload.offset) % IMAGE_CHUNK_BYTES !== 0
  )
    error("invalid_image_request");
  const a = s.assets.get(payload.imageId),
    offset = Number(payload.offset);
  if (!a?.committed || !a.finished || offset >= a.bytes.length)
    error("image_unavailable");
  return {
    imageId: a.image.id,
    offset,
    data: a.bytes
      .subarray(offset, offset + IMAGE_CHUNK_BYTES)
      .toString("base64"),
    byteLength: a.image.byteLength,
  };
}
function publicReceipt(r: Receipt): SubmissionReceipt {
  return {
    submissionKey: r.submissionKey,
    messageId: r.messageId,
    status: r.status,
  };
}
export function submissionStatus(
  room: SecureRoom,
  key: unknown,
): SubmissionReceipt {
  if (!validId(key)) error("invalid_submission");
  const r = state(room).receipts.get(key);
  if (!r) error("submission_missing");
  return publicReceipt(r);
}
export async function submitRoomMessage(
  room: SecureRoom,
  owner: string,
  name: string,
  payload: unknown,
  rateLimit: () => boolean,
  send: (
    text: string,
    options: {
      messageId: string;
      images?: Array<{ data: string; mimeType: string }>;
    },
    signal: AbortSignal,
  ) => Promise<void>,
): Promise<SubmissionReceipt> {
  const s = state(room);
  if (
    !isObject(payload) ||
    !validId(payload.submissionKey) ||
    typeof payload.message !== "string" ||
    Buffer.byteLength(payload.message) > 32 * 1024
  )
    error("invalid_submission");
  const message = payload.message.trim(),
    imageId = payload.imageId;
  if (!message && !imageId) error("empty_message");
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([message, imageId ?? null, payload.capability ?? null]),
    )
    .digest("hex");
  const prior = s.receipts.get(payload.submissionKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) error("submission_changed");
    return publicReceipt(prior);
  }
  if (s.dispatch || activeSends >= 2) error("send_busy");
  if (
    s.receipts.size >= ATTACHMENT_LIMITS.roomReceipts ||
    totalReceipts >= ATTACHMENT_LIMITS.globalReceipts
  )
    error("room_full");
  const a = imageId === undefined ? undefined : owned(s, owner, payload);
  if (a && !a.finished) error("incomplete_image");
  if (!rateLimit()) error("rate_limited");
  const r: Receipt = {
    submissionKey: payload.submissionKey,
    messageId: id(),
    status: "pending",
    fingerprint,
    ...(a ? { imageId: a.image.id } : {}),
  };
  s.receipts.set(r.submissionKey, r);
  totalReceipts++;
  activeSends++;
  if (a) {
    a.committed = true;
    s.associations.set(r.messageId, a.image.id);
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let released = false;
  let finishCancellation!: () => void;
  const canceled = new Promise<void>((resolve) => {
    finishCancellation = resolve;
  });
  const releaseDispatch = () => {
    if (released) return;
    released = true;
    if (timeout) clearTimeout(timeout);
    if (s.dispatch === dispatch) s.dispatch = null;
    activeSends--;
  };
  const dispatch = {
    cancel() {
      if (released) return;
      if (s.alive && r.status === "pending") r.status = "unknown";
      // Production send owns an isolated SDK client and closes its transport
      // on abort. Capacity can recover without orphaning shared-client RPCs.
      controller.abort();
      releaseDispatch();
      finishCancellation();
    },
  };
  s.dispatch = dispatch;
  timeout = setTimeout(() => dispatch.cancel(), ATTACHMENT_LIMITS.sendMs);
  const dispatched = Promise.resolve()
    .then(() => {
      if (!s.alive || controller.signal.aborted) error("room_closed");
      return send(
        `[${name}]\n${message}`,
        {
          messageId: r.messageId,
          ...(a
            ? {
                images: [
                  {
                    data: a.bytes.toString("base64"),
                    mimeType: a.image.mimeType,
                  },
                ],
              }
            : {}),
        },
        controller.signal,
      );
    })
    .then(
      () => {
        if (s.alive) r.status = "accepted";
      },
      (cause: unknown) => {
        // A timeout/disconnect is ambiguous. Only an explicit SDK rejection or
        // local pre-dispatch validation permits releasing the association.
        if (!s.alive) return;
        if (r.status === "accepted") return;
        if (
          cause instanceof Error &&
          cause.message === "sendAgentMessage rejected"
        ) {
          r.status = "rejected";
          if (a) {
            s.associations.delete(r.messageId);
            release(s, a);
          }
        } else r.status = "unknown";
      },
    )
    .finally(releaseDispatch);
  await Promise.race([dispatched, canceled]);
  if (!s.alive) error("room_closed");
  return publicReceipt(r);
}
/** Only exact SDK IDs from this room may add metadata; upstream bytes are stripped. */
export function decorateRoomItem(room: SecureRoom, item: unknown): unknown {
  if (!isObject(item) || item.type !== "user_message") return item;
  const clean: Record<string, unknown> = {
    type: "user_message",
    text: typeof item.text === "string" ? item.text : "",
  };
  for (const key of ["messageId", "clientMessageId"] as const)
    if (typeof item[key] === "string" && item[key].length <= 256)
      clean[key] = item[key];
  const s = states.get(room.token);
  if (s?.room === room) {
    const alias = [item.clientMessageId, item.messageId].find(
      (value) => typeof value === "string" && s.associations.has(value),
    );
    const imageId =
      typeof alias === "string" ? s.associations.get(alias) : undefined;
    const a = imageId ? s.assets.get(imageId) : undefined;
    if (a?.committed) {
      clean.roomImages = [{ ...a.image }];
      // Daemon-provided aliases can be used for this one association only.
      for (const key of [item.messageId, item.clientMessageId])
        if (
          typeof key === "string" &&
          key.length <= 256 &&
          s.associations.size < ATTACHMENT_LIMITS.roomImages * 3
        )
          s.associations.set(key, a.image.id);
      for (const receipt of s.receipts.values())
        if (receipt.imageId === a.image.id && receipt.status !== "rejected")
          receipt.status = "accepted";
    }
  }
  return clean;
}
