import {
  MAX_IMAGE_AXIS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  type ImageMimeType,
} from "../shared/room-attachments.js";

function fail(): never {
  throw new Error("invalid_image");
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff;
  for (let i = start; i < end; i++)
    value = crcTable[(value ^ bytes[i]) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function dimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_AXIS ||
    height > MAX_IMAGE_AXIS ||
    width * height > MAX_IMAGE_PIXELS
  )
    fail();
  return { width, height };
}
/** Bounded container validation, not a compressed raster decoder. */
export function validateImage(
  bytes: Uint8Array,
  mimeType: ImageMimeType,
): { width: number; height: number } {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, count: number) =>
    String.fromCharCode(...bytes.subarray(at, at + count));
  if (mimeType === "image/png") {
    if (
      bytes.length < 45 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
    )
      fail();
    let offset = 8;
    let size: { width: number; height: number } | undefined;
    let data = false;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = ascii(offset + 4, 4);
      if (length > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type))
        fail();
      if (
        crc(bytes, offset + 4, offset + 8 + length) !==
        view.getUint32(offset + 8 + length)
      )
        fail();
      if (!size) {
        if (type !== "IHDR" || length !== 13) fail();
        size = dimensions(
          view.getUint32(offset + 8),
          view.getUint32(offset + 12),
        );
        const depth = bytes[offset + 16],
          color = bytes[offset + 17];
        const depths: Record<number, number[]> = {
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        };
        if (
          !depths[color]?.includes(depth) ||
          bytes[offset + 18] !== 0 ||
          bytes[offset + 19] !== 0 ||
          bytes[offset + 20] > 1
        )
          fail();
      } else if (type === "IHDR" || ["acTL", "fcTL", "fdAT"].includes(type))
        fail();
      if (type === "IDAT") {
        if (!length) fail();
        data = true;
      }
      offset += length + 12;
      if (type === "IEND") {
        if (length || !data || offset !== bytes.length) fail();
        ended = true;
        break;
      }
    }
    if (!size || !ended) fail();
    return size;
  }
  if (mimeType === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) fail();
    let offset = 2;
    let size: { width: number; height: number } | undefined;
    let scan = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) fail();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217) {
        if (!size || !scan || offset !== bytes.length) fail();
        return size;
      }
      if (
        marker === 0 ||
        marker === 216 ||
        marker === undefined ||
        (marker >= 208 && marker <= 215)
      )
        fail();
      if (offset + 2 > bytes.length) fail();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) fail();
      if ([192, 193, 194].includes(marker)) {
        if (size || length < 11 || bytes[offset + 2] !== 8) fail();
        const components = bytes[offset + 7];
        if (![1, 3, 4].includes(components) || length !== 8 + 3 * components)
          fail();
        size = dimensions(
          view.getUint16(offset + 5),
          view.getUint16(offset + 3),
        );
      } else if (
        marker >= 192 &&
        marker <= 207 &&
        ![196, 200, 204].includes(marker)
      )
        fail();
      offset += length;
      if (marker === 218) {
        if (!size || length < 6) fail();
        scan = true;
        while (offset < bytes.length) {
          if (bytes[offset++] !== 255) continue;
          const next = bytes[offset];
          if (next === 0 || (next >= 208 && next <= 215)) {
            offset++;
            continue;
          }
          if (next === 255) continue;
          offset--;
          break;
        }
      }
    }
    fail();
  }
  if (mimeType === "image/webp") {
    if (
      bytes.length < 20 ||
      ascii(0, 4) !== "RIFF" ||
      ascii(8, 4) !== "WEBP" ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      fail();
    let offset = 12;
    let extended: { width: number; height: number } | undefined;
    let size: { width: number; height: number } | undefined;
    while (offset + 8 <= bytes.length) {
      const type = ascii(offset, 4),
        length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (
        length > bytes.length - start ||
        start + length + (length % 2) > bytes.length
      )
        fail();
      if (type === "ANIM" || type === "ANMF") fail();
      const u24 = (at: number) =>
        bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
      if (type === "VP8X") {
        if (
          offset !== 12 ||
          extended ||
          length !== 10 ||
          bytes[start] & 0xc3 ||
          bytes[start + 1] ||
          bytes[start + 2] ||
          bytes[start + 3]
        )
          fail();
        extended = dimensions(1 + u24(start + 4), 1 + u24(start + 7));
      } else if (type === "VP8 ") {
        if (
          size ||
          length < 10 ||
          bytes[start] & 1 ||
          ascii(start + 3, 3) !== "\x9d\x01\x2a"
        )
          fail();
        size = dimensions(
          view.getUint16(start + 6, true) & 0x3fff,
          view.getUint16(start + 8, true) & 0x3fff,
        );
      } else if (type === "VP8L") {
        if (
          size ||
          length < 5 ||
          bytes[start] !== 47 ||
          bytes[start + 4] & 0xe0
        )
          fail();
        const bits = view.getUint32(start + 1, true);
        size = dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
      } else if (!["ALPH", "ICCP", "EXIF", "XMP "].includes(type)) fail();
      offset = start + length + (length % 2);
    }
    if (
      offset !== bytes.length ||
      !size ||
      (extended &&
        (extended.width !== size.width || extended.height !== size.height))
    )
      fail();
    return size;
  }
  return fail();
}
