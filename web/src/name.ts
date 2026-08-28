/** Keep browser display names aligned with the server's public-name rules. */
export function sanitizeDisplayName(raw: string): string | null {
  if (/[\n\r]/.test(raw)) return null;
  const name = raw.replace(/[[\]]/g, "").trim().slice(0, 40);
  return name.length > 0 ? name : null;
}
