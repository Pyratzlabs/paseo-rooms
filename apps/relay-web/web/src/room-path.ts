/** Resolve room routes relative to the static client's deployment base path. */
export function tokenFromPath(pathname: string, basePath = "/"): string | null {
  if (!pathname.startsWith(basePath)) return null;
  const parts = pathname.slice(basePath.length).split("/").filter(Boolean);
  return parts[0] === "r" && parts.length === 2 ? parts[1]! : null;
}
