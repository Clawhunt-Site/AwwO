import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Layers, Package, Search, X } from "lucide-react";
import type { To } from "react-router-dom";
import {
  artifactsApi,
  type ArtifactGroupBy,
  type ArtifactKindFilter,
} from "../api/artifacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ArtifactCard } from "../components/artifacts/ArtifactCard";
import { ArtifactGroupCard } from "../components/artifacts/ArtifactGroupCard";
import { useSearchParams, Link } from "@/lib/router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { type LocalizedText, useLocalizedText } from "../i18n/localized";

const ARTIFACTS_PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;

export const ARTIFACT_KIND_FILTERS: { value: ArtifactKindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "document", label: "Documents" },
  { value: "text", label: "Text" },
  { value: "file", label: "Files" },
];

export const ARTIFACT_GROUP_OPTIONS: { value: ArtifactGroupBy; label: string }[] = [
  { value: "none", label: "None" },
  { value: "task", label: "Task" },
  { value: "parent_task", label: "Parent task" },
];

const artifactKindFilterCopy: Record<ArtifactKindFilter, LocalizedText> = {
  all: { en: "All", zh: "全部" },
  image: { en: "Images", zh: "图片" },
  video: { en: "Videos", zh: "视频" },
  document: { en: "Documents", zh: "文档" },
  text: { en: "Text", zh: "文本" },
  file: { en: "Files", zh: "文件" },
};

const artifactGroupByCopy: Record<ArtifactGroupBy, LocalizedText> = {
  none: { en: "None", zh: "无" },
  task: { en: "Task", zh: "任务" },
  parent_task: { en: "Parent task", zh: "父任务" },
};

const KIND_VALUES = new Set(ARTIFACT_KIND_FILTERS.map((filter) => filter.value));

function parseGroupBy(value: string | null): ArtifactGroupBy {
  if (value === "none" || value === "task" || value === "parent_task") return value;
  return "task";
}

function parseKind(value: string | null): ArtifactKindFilter {
  return value && KIND_VALUES.has(value as ArtifactKindFilter)
    ? (value as ArtifactKindFilter)
    : "all";
}

export function artifactGroupByLabel(value: ArtifactGroupBy): string {
  return ARTIFACT_GROUP_OPTIONS.find((option) => option.value === value)?.label ?? "None";
}

export function Artifacts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const localize = useLocalizedText();
  const [searchParams, setSearchParams] = useSearchParams();

  const kind = parseKind(searchParams.get("kind"));
  const query = searchParams.get("q") ?? "";
  const groupBy = parseGroupBy(searchParams.get("groupBy"));
  const groupIssueId = searchParams.get("groupIssueId") ?? undefined;

  const [draftQuery, setDraftQuery] = useState(query);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const grouping = groupBy !== "none";
  const viewingStackList = grouping && !groupIssueId;
  const viewingSelectedStack = grouping && !!groupIssueId;

  // Keep the search box in sync when the committed query changes from outside
  // (e.g. back/forward navigation or a shared URL), without clobbering in-flight
  // typing (which leaves `query` unchanged until the debounce commits).
  useEffect(() => {
    setDraftQuery((prev) => (prev.trim() === query ? prev : query));
  }, [query]);

  // Debounce the search box into the `q` URL param so searches are shareable.
  useEffect(() => {
    const trimmed = draftQuery.trim();
    if (trimmed === query) return;
    const handle = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (trimmed) next.set("q", trimmed);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftQuery, query, setSearchParams]);

  const updateParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      });
    },
    [setSearchParams],
  );

  const selectKind = useCallback(
    (value: ArtifactKindFilter) => {
      updateParams((next) => {
        if (value === "all") next.delete("kind");
        else next.set("kind", value);
      });
    },
    [updateParams],
  );

  const selectGroupBy = useCallback(
    (value: ArtifactGroupBy) => {
      updateParams((next) => {
        // Switching the grouping mode always returns to the stack list.
        next.delete("groupIssueId");
        if (value === "task") next.delete("groupBy");
        else next.set("groupBy", value);
      });
    },
    [updateParams],
  );

  // Build a relative `To` that preserves the active filters/search while
  // changing only the grouping selection. A bare query string keeps the current
  // pathname (the company-prefixed /artifacts route) and stays linkable.
  const buildTo = useCallback(
    (mutate: (next: URLSearchParams) => void): To => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      const serialized = next.toString();
      return serialized ? `?${serialized}` : "?";
    },
    [searchParams],
  );

  const stackTo = useCallback(
    (issueId: string): To =>
      buildTo((next) => {
        if (groupBy === "task") next.delete("groupBy");
        else if (groupBy !== "none") next.set("groupBy", groupBy);
        next.set("groupIssueId", issueId);
      }),
    [buildTo, groupBy],
  );

  const backToStacksTo = useMemo<To>(
    () =>
      buildTo((next) => {
        if (groupBy === "task") next.delete("groupBy");
        next.delete("groupIssueId");
      }),
    [buildTo, groupBy],
  );

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
  } = useInfiniteQuery({
    queryKey: queryKeys.artifacts.list(selectedCompanyId!, kind, query, groupBy, groupIssueId),
    queryFn: ({ pageParam }) =>
      artifactsApi.list(selectedCompanyId!, {
        kind,
        q: query || undefined,
        groupBy,
        groupIssueId,
        limit: ARTIFACTS_PAGE_SIZE,
        cursor: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void fetchNextPage();
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const artifacts = useMemo(() => data?.pages.flatMap((page) => page.artifacts) ?? [], [data]);
  const groups = useMemo(
    () => data?.pages.flatMap((page) => page.groups ?? []) ?? [],
    [data],
  );
  const selectedGroup = useMemo(
    () => data?.pages.map((page) => page.selectedGroup).find(Boolean) ?? null,
    [data],
  );
  const searching = query.length > 0;

  useEffect(() => {
    if (viewingSelectedStack && selectedGroup) {
      setBreadcrumbs([
        { label: localize({ en: "Artifacts", zh: "产物" }), href: "/artifacts" },
        { label: `${selectedGroup.issue.identifier} · ${selectedGroup.title}` },
      ]);
    } else {
      setBreadcrumbs([{ label: localize({ en: "Artifacts", zh: "产物" }) }]);
    }
  }, [localize, setBreadcrumbs, viewingSelectedStack, selectedGroup]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Package} message={localize({ en: "Select a company to view artifacts.", zh: "选择一个公司查看产物。" })} />;
  }

  const showGroupCards = viewingStackList;
  const items = showGroupCards ? groups : artifacts;

  const emptyMessage = showGroupCards
    ? searching
      ? localize({ en: "No artifact stacks match this search.", zh: "没有产物堆栈匹配搜索。" })
      : localize({ en: "No artifact stacks yet.", zh: "还没有产物堆栈。" })
    : searching
      ? localize({ en: "No artifacts match this search.", zh: "没有产物匹配搜索。" })
      : viewingSelectedStack
        ? localize({ en: "No artifacts in this stack match the current filters.", zh: "此堆栈中没有产物匹配当前筛选。" })
        : kind === "all"
          ? localize({ en: "No artifacts yet. Outputs attached to issues will appear here.", zh: "还没有产物。附加到任务的输出会显示在这里。" })
          : localize({ en: "No artifacts of this type yet.", zh: "还没有这种类型的产物。" });

  return (
    <div className="w-full max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
            placeholder={localize({ en: "Search artifacts...", zh: "搜索产物..." })}
            aria-label={localize({ en: "Search artifacts", zh: "搜索产物" })}
            className="h-9 pl-9 pr-9 text-sm"
          />
          {draftQuery.length > 0 ? (
            <button
              type="button"
              onClick={() => setDraftQuery("")}
              aria-label={localize({ en: "Clear artifact search", zh: "清除产物搜索" })}
              className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={localize({
                  en: `Group artifacts (currently ${artifactGroupByLabel(groupBy)})`,
                  zh: `产物分组（当前：${localize(artifactGroupByCopy[groupBy])}）`,
                })}
                title={localize({ en: "Group artifacts", zh: "产物分组" })}
                data-testid="artifact-group-control"
                data-group-by={groupBy}
                className={cn("h-8 w-8 shrink-0", grouping && "bg-accent")}
              >
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>{localize({ en: "Group by", zh: "分组依据" })}</DropdownMenuLabel>
              {ARTIFACT_GROUP_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  data-testid={`artifact-group-option-${option.value}`}
                  aria-selected={groupBy === option.value}
                  onSelect={() => selectGroupBy(option.value)}
                  className="justify-between"
                >
                  {localize(artifactGroupByCopy[option.value] ?? { en: option.label, zh: option.label })}
                  {groupBy === option.value ? <Check className="h-3.5 w-3.5" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={localize({ en: "Filter artifacts by type", zh: "按类型筛选产物" })}>
            {ARTIFACT_KIND_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                role="tab"
                aria-selected={kind === filter.value}
                onClick={() => selectKind(filter.value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  kind === filter.value
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {localize(artifactKindFilterCopy[filter.value] ?? { en: filter.label, zh: filter.label })}
              </button>
            ))}
          </div>
        </div>
      </div>

      {viewingSelectedStack ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            to={backToStacksTo}
            data-testid="artifact-stack-back"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {localize({ en: "All stacks", zh: "全部堆栈" })}
          </Link>
          {selectedGroup ? (
            <span className="truncate text-muted-foreground">
              <span className="text-foreground/80">{selectedGroup.issue.identifier}</span>{" "}
              {selectedGroup.title}
            </span>
          ) : null}
        </div>
      ) : null}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : items.length === 0 ? (
        <EmptyState icon={showGroupCards ? Layers : Package} message={emptyMessage} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {showGroupCards
              ? groups.map((group) => (
                  <ArtifactGroupCard key={group.id} group={group} to={stackTo(group.issue.id)} />
                ))
              : artifacts.map((artifact) => (
                  <ArtifactCard key={`${artifact.source}:${artifact.id}`} artifact={artifact} />
                ))}
          </div>
          <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center pb-2 text-xs text-muted-foreground">
            {isFetchingNextPage
              ? localize({ en: "Loading more artifacts...", zh: "正在加载更多产物..." })
              : hasNextPage
                ? null
                : isFetching
                  ? localize({ en: "Updating artifacts...", zh: "正在更新产物..." })
                  : null}
          </div>
        </>
      )}
    </div>
  );
}
