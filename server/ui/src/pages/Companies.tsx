import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { useLocalizedText } from "@/i18n/localized";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Pencil,
  Check,
  X,
  Plus,
  MoreHorizontal,
  Trash2,
  RefreshCw,
} from "lucide-react";

// Company directory — super's card-grid + empty-state presentation, mounted as the
// board's landing surface. It replaces the board's flat single-column list so the
// Team tab opens onto a glanceable grid of companies (click a card to enter) instead
// of auto-dropping into one company's Dashboard. Data is 100% the Node control plane
// (companiesApi / useCompany / company.logoUrl) — this is a presentation swap, not a
// new data source. All board functionality is preserved (inline rename, delete via the
// hover ··· menu, create via the onboarding dialog).
export function Companies() {
  const {
    companies,
    selectedCompanyId,
    setSelectedCompanyId,
    loading,
    error,
    reloadCompanies,
  } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const localize = useLocalizedText();

  const { data: stats } = useQuery({
    queryKey: queryKeys.companies.stats,
    queryFn: () => companiesApi.stats(),
  });

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const editMutation = useMutation({
    mutationFn: ({ id, newName }: { id: string; newName: string }) =>
      companiesApi.update(id, { name: newName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => companiesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      setConfirmDeleteId(null);
    },
  });

  useEffect(() => {
    setBreadcrumbs([{ label: localize({ en: "Companies", zh: "公司" }) }]);
  }, [setBreadcrumbs, localize]);

  function startEdit(companyId: string, currentName: string) {
    setEditingId(companyId);
    setEditName(currentName);
  }

  function saveEdit() {
    if (!editingId || !editName.trim()) return;
    editMutation.mutate({ id: editingId, newName: editName.trim() });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
  }

  function enterCompany(company: { id: string; issuePrefix: string }) {
    setSelectedCompanyId(company.id);
    // Navigate with the clicked company's explicit prefix. setSelectedCompanyId is async,
    // so a bare navigate("/dashboard") would resolve its prefix from the *previous*
    // selection (or none, on the unprefixed home) and could enter the wrong company.
    navigate(`/${company.issuePrefix}/dashboard`);
  }

  const newCompanyLabel = localize({ en: "New company", zh: "新建公司" });
  const showEmpty = !loading && !error && companies.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: lede + refresh + create */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground max-w-[62%]">
          {localize({
            en: "Each company is a governance namespace: its own roster, task board, budget, and approval gate.",
            zh: "每家公司是一个治理命名空间：独立的花名册、工单看板、预算与审批门。",
          })}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reloadCompanies()}
            className="text-muted-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            {localize({ en: "Refresh", zh: "刷新" })}
          </Button>
          <Button size="sm" onClick={() => openOnboarding()}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            {newCompanyLabel}
          </Button>
        </div>
      </div>

      <div className="h-5">
        {loading && (
          <p className="text-sm text-muted-foreground">
            {localize({ en: "Loading companies…", zh: "正在加载公司…" })}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error.message}</p>}
      </div>

      {showEmpty ? (
        <div className="flex flex-col items-center gap-3 text-center border border-dashed border-border rounded-[14px] px-6 py-16">
          <h2 className="text-lg font-medium m-0">
            {localize({ en: "Create your first company", zh: "创建你的第一家公司" })}
          </h2>
          <p className="text-sm text-muted-foreground m-0 max-w-[420px]">
            {localize({
              en: "Start by creating a company — a team of agents with a charter, a board, and budgets.",
              zh: "从创建一家公司开始 —— 一组带章程、董事会与预算的 Agent。",
            })}
          </p>
          <Button size="sm" className="mt-1" onClick={() => openOnboarding()}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            {newCompanyLabel}
          </Button>
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
        >
          {companies.map((company) => {
            const selected = company.id === selectedCompanyId;
            const isEditing = editingId === company.id;
            const isConfirmingDelete = confirmDeleteId === company.id;
            const companyStats = stats?.[company.id];
            const agentCount = companyStats?.agentCount ?? 0;
            const issueCount = companyStats?.issueCount ?? 0;

            return (
              <div
                key={company.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (isEditing || isConfirmingDelete) return;
                  enterCompany(company);
                }}
                onKeyDown={(e) => {
                  // Only act on the card's own focus — Enter/Space while focus is on a
                  // nested control (the ··· menu trigger/items, the inline-rename input)
                  // bubbles here; without this guard a keyboard user opening the menu would
                  // instead enter the company.
                  if (e.target !== e.currentTarget) return;
                  if (isEditing || isConfirmingDelete) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    enterCompany(company);
                  }
                }}
                className={`group relative flex flex-col gap-2 text-left p-4 rounded-[12px] border bg-muted/50 cursor-pointer transition-colors ${
                  selected
                    ? "border-primary ring-1 ring-primary"
                    : "border-border hover:border-foreground/25 hover:bg-muted"
                }`}
              >
                {/* Head: logo + name (+ status) + hover ··· menu */}
                <div className="flex items-center gap-2.5 min-w-0">
                  <CompanyPatternIcon
                    companyName={company.name}
                    logoUrl={company.logoUrl}
                    brandColor={company.brandColor}
                    className="h-10 w-10 rounded-[10px] shrink-0"
                  />
                  {isEditing ? (
                    <div
                      className="flex items-center gap-1.5 flex-1 min-w-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-7 text-sm"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit();
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={saveEdit}
                        disabled={editMutation.isPending}
                      >
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      </Button>
                      <Button variant="ghost" size="icon-xs" onClick={cancelEdit}>
                        <X className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <strong className="flex-1 min-w-0 truncate text-[15px] font-medium">
                        {company.name}
                      </strong>
                      {company.status !== "active" && (
                        <span
                          className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            company.status === "paused"
                              ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {company.status}
                        </span>
                      )}
                      <div
                        className="shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-muted-foreground opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                              aria-label={localize({ en: "Company actions", zh: "公司操作" })}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => startEdit(company.id, company.name)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              {localize({ en: "Rename", zh: "重命名" })}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => {
                                // The mutation object is shared across cards — clear
                                // any error left by a previous attempt so it can't
                                // bleed into this company's confirm panel.
                                deleteMutation.reset();
                                setConfirmDeleteId(company.id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {localize({ en: "Delete company", zh: "删除公司" })}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </>
                  )}
                </div>

                {company.description && !isEditing && (
                  <p className="text-xs text-muted-foreground m-0 line-clamp-2">
                    {company.description}
                  </p>
                )}

                <div className="flex gap-3 text-xs text-muted-foreground mt-auto pt-1">
                  <span>
                    {localize({
                      en: `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`,
                      zh: `${agentCount} 个 Agent`,
                    })}
                  </span>
                  <span>
                    {localize({
                      en: `${issueCount} ${issueCount === 1 ? "task" : "tasks"}`,
                      zh: `${issueCount} 个工单`,
                    })}
                  </span>
                </div>

                {isConfirmingDelete && (
                  <div
                    className="mt-2 flex flex-col gap-2 bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-xs text-destructive font-medium m-0 break-words">
                      {localize({
                        en: "Delete this company and all its data? This cannot be undone.",
                        zh: "删除这家公司及其全部数据？此操作不可撤销。",
                      })}
                    </p>
                    {deleteMutation.isError && (
                      <p className="text-xs text-destructive m-0 break-words" role="alert">
                        {localize({ en: "Delete failed: ", zh: "删除失败：" })}
                        {deleteMutation.error instanceof Error
                          ? deleteMutation.error.message
                          : String(deleteMutation.error)}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={deleteMutation.isPending}
                      >
                        {localize({ en: "Cancel", zh: "取消" })}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteMutation.mutate(company.id)}
                        disabled={deleteMutation.isPending}
                      >
                        {deleteMutation.isPending
                          ? localize({ en: "Deleting…", zh: "删除中…" })
                          : localize({ en: "Delete", zh: "删除" })}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
