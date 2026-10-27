/** Wire contract: image bytes travel only in encrypted, acknowledged chunks. */
export const IMAGE_CAPABILITY = "room-images-v1";
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 24 * 1024;
export const MAX_IMAGE_AXIS = 8192;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const IMAGE_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_REQUEST_ID_LENGTH = 64;
export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export interface RoomImage {
  id: string;
  mimeType: ImageMimeType;
  byteLength: number;
  width: number;
  height: number;
}
export interface UploadedImage {
  image: RoomImage;
  capability: string;
}
export type SubmissionStatus = "pending" | "accepted" | "rejected" | "unknown";
export interface SubmissionReceipt {
  submissionKey: string;
  messageId: string;
  status: SubmissionStatus;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}
export function isImageMime(value: unknown): value is ImageMimeType {
  return IMAGE_MIME_TYPES.includes(value as ImageMimeType);
}
export function isRoomImage(value: unknown): value is RoomImage {
  return (
    isObject(value) &&
    validId(value.id) &&
    isImageMime(value.mimeType) &&
    Number.isSafeInteger(value.byteLength) &&
    Number(value.byteLength) > 0 &&
    Number(value.byteLength) <= MAX_IMAGE_BYTES &&
    Number.isSafeInteger(value.width) &&
    Number(value.width) > 0 &&
    Number(value.width) <= MAX_IMAGE_AXIS &&
    Number.isSafeInteger(value.height) &&
    Number(value.height) > 0 &&
    Number(value.height) <= MAX_IMAGE_AXIS &&
    Number(value.width) * Number(value.height) <= MAX_IMAGE_PIXELS
  );
}
