const BOARD_ROUTE_ROOTS = new Set([
  "dashboard",
  "company",
  "skills",
  "teams-catalog",
  "org",
  "agents",
  "projects",
  "workspaces",
  "execution-workspaces",
  "issues",
  "routines",
  "goals",
  "artifacts",
  "approvals",
  "costs",
  "usage",
  "activity",
  "inbox",
  "board-chat",
  "artifacts",
  "u",
  "design-guide",
  "search",
  "settings",
]);

// "companies" is the cross-company directory (Team home) — it is NOT scoped to any
// single company, so it stays a top-level (unprefixed) route and renders full-page
// without the per-company sidebar/breadcrumb shell. "onboarding" is likewise a
// top-level route (App.tsx mounts it outside the :companyPrefix layout); listing it
// here keeps extractCompanyPrefixFromPath from misreading "/onboarding" as a company
// prefix "ONBOARDING" (which would make the host topbar treat it as an in-company page).
const GLOBAL_ROUTE_ROOTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs", "instance", "companies", "onboarding"]);

export function normalizeCompanyPrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

function splitPath(path: string): { pathname: string; search: string; hash: string } {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? path,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function getRootSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment ?? null;
}

export function isGlobalPath(pathname: string): boolean {
  if (pathname === "/") return true;
  const root = getRootSegment(pathname);
  if (!root) return true;
  return GLOBAL_ROUTE_ROOTS.has(root.toLowerCase());
}

export function isBoardPathWithoutPrefix(pathname: string): boolean {
  const root = getRootSegment(pathname);
  if (!root) return false;
  return BOARD_ROUTE_ROOTS.has(root.toLowerCase());
}

export function extractCompanyPrefixFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0]!.toLowerCase();
  if (GLOBAL_ROUTE_ROOTS.has(first) || BOARD_ROUTE_ROOTS.has(first)) {
    return null;
  }
  return normalizeCompanyPrefix(segments[0]!);
}

export function applyCompanyPrefix(path: string, companyPrefix: string | null | undefined): string {
  const { pathname, search, hash } = splitPath(path);
  if (!pathname.startsWith("/")) return path;
  if (isGlobalPath(pathname)) return path;
  if (!companyPrefix) return path;

  const prefix = normalizeCompanyPrefix(companyPrefix);
  const activePrefix = extractCompanyPrefixFromPath(pathname);
  if (activePrefix) return path;

  return `/${prefix}${pathname}${search}${hash}`;
}

export function toCompanyRelativePath(path: string): string {
  const { pathname, search, hash } = splitPath(path);
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length >= 2) {
    const second = segments[1]!.toLowerCase();
    if (!GLOBAL_ROUTE_ROOTS.has(segments[0]!.toLowerCase()) && BOARD_ROUTE_ROOTS.has(second)) {
      return `/${segments.slice(1).join("/")}${search}${hash}`;
    }
  }

  return `${pathname}${search}${hash}`;
}
