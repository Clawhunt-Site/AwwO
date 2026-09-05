import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  GripVertical,
  LogOut,
  Plus,
  Settings,
  UserPlus,
} from "lucide-react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Company } from "@paperclipai/shared";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useCompanyOrder } from "@/hooks/useCompanyOrder";
import { useLocalizedText } from "@/i18n/localized";
import { queryKeys } from "@/lib/queryKeys";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

interface SidebarCompanyMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function WorkspaceIcon({ company }: { company: Company }) {
  return (
    <CompanyPatternIcon
      companyName={company.name}
      logoUrl={company.logoUrl}
      brandColor={company.brandColor}
      className="size-5 shrink-0 rounded-md text-[11px]"
    />
  );
}

function SortableCompanyItem({
  company,
  isEditing,
  isSelected,
  onSelect,
  reorderLabel,
}: {
  company: Company;
  isEditing: boolean;
  isSelected: boolean;
  onSelect: (company: Company) => void;
  reorderLabel: (companyName: string) => string;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: company.id, disabled: !isEditing });

  return (
    <DropdownMenuItem
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      onSelect={(event) => {
        if (isEditing) {
          event.preventDefault();
          return;
        }
        onSelect(company);
      }}
      className={cn(
        "min-w-0 gap-2 py-2",
        isEditing && "cursor-grab",
        isDragging && "opacity-80",
        isSelected && "bg-muted/75 text-foreground dark:bg-muted/45",
      )}
    >
      <WorkspaceIcon company={company} />
      <span className="min-w-0 flex-1 truncate">{company.name}</span>
      {isEditing ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={reorderLabel(company.name)}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring dark:hover:bg-muted/35"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      ) : (
        <>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {company.issuePrefix}
          </span>
          {isSelected ? <Check className="size-4 text-muted-foreground" /> : null}
        </>
      )}
    </DropdownMenuItem>
  );
}

export function SidebarCompanyMenu({ open: controlledOpen, onOpenChange }: SidebarCompanyMenuProps = {}) {
  const localize = useLocalizedText();
  const [internalOpen, setInternalOpen] = useState(false);
  const [isEditingOrder, setIsEditingOrder] = useState(false);
  const queryClient = useQueryClient();
  const { companies, selectedCompany, setSelectedCompanyId } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const location = useLocation();
  const navigate = useNavigate();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
  );
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedCompanies, persistOrder } = useCompanyOrder({
    companies: sidebarCompanies,
    userId: currentUserId,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      if (isMobile) setSidebarOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setIsEditingOrder(false);
    setOpen(nextOpen);
  }

  function closeNavigationChrome() {
    setOpen(false);
    setIsEditingOrder(false);
    if (isMobile) setSidebarOpen(false);
  }

  function selectCompany(company: Company) {
    const pathPrefix = location.pathname.split("/")[1]?.toUpperCase();
    const isCompanyRoute = sidebarCompanies.some((sidebarCompany) => (
      sidebarCompany.issuePrefix.toUpperCase() === pathPrefix
    ));
    const shouldLeaveCurrentRoute = company.id !== selectedCompany?.id
      && (location.pathname.startsWith("/instance/") || isCompanyRoute);

    setSelectedCompanyId(company.id);
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    if (shouldLeaveCurrentRoute) {
      navigate(`/${company.issuePrefix}/dashboard`);
    }
  }

  function addCompany() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    openOnboarding();
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedCompanies.map((company) => company.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedCompanies, persistOrder],
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          // `px-3` (not px-2) so the logo's left edge lines up with the nav icon
          // column (nav px-3 + item px-3) and, crucially, stays put between states:
          // the Button's default size adds `has-[>svg]:px-3`, so with the chevron
          // svg present (expanded) it was already 12px but without it (rail) it fell
          // back to 8px — a 4px horizontal jump on collapse (PAP-10676).
          className="h-9 flex-1 justify-start gap-2 px-3 text-left"
          aria-label={selectedCompany
            ? localize({
              en: `Open ${selectedCompany.name} company switcher`,
              zh: `打开 ${selectedCompany.name} 公司切换器`,
            })
            : localize({ en: "Open company switcher", zh: "打开公司切换器" })}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selectedCompany ? <WorkspaceIcon company={selectedCompany} /> : null}
            <span className={cn("truncate text-sm font-bold text-foreground", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}>
              {selectedCompany?.name ?? localize({ en: "Select company", zh: "选择公司" })}
            </span>
          </span>
          {!rail && <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-64 p-1">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-[11px] font-semibold uppercase text-muted-foreground">
            {localize({ en: "Switch company", zh: "切换公司" })}
          </DropdownMenuLabel>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsEditingOrder((current) => !current);
            }}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground dark:hover:bg-muted/35"
          >
            {isEditingOrder ? localize({ en: "Done", zh: "完成" }) : localize({ en: "Edit", zh: "编辑" })}
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedCompanies.map((company) => company.id)}
              strategy={verticalListSortingStrategy}
            >
              {orderedCompanies.map((company) => (
                <SortableCompanyItem
                  key={company.id}
                  company={company}
                  isEditing={isEditingOrder}
                  isSelected={company.id === selectedCompany?.id}
                  onSelect={selectCompany}
                  reorderLabel={(companyName) => localize({
                    en: `Reorder ${companyName}`,
                    zh: `调整 ${companyName} 的顺序`,
                  })}
                />
              ))}
            </SortableContext>
          </DndContext>
          {orderedCompanies.length === 0 ? (
            <DropdownMenuItem disabled>{localize({ en: "No companies", zh: "暂无公司" })}</DropdownMenuItem>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={addCompany}
          className="gap-2 py-2 text-muted-foreground"
          disabled={isEditingOrder}
        >
          <Plus className="size-4" />
          <span>{localize({ en: "Create new company...", zh: "创建新公司..." })}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild disabled={isEditingOrder}>
          <Link
            to="/company/settings/invites"
            onClick={(event) => {
              if (isEditingOrder) {
                event.preventDefault();
                return;
              }
              closeNavigationChrome();
            }}
          >
            <UserPlus className="size-4" />
            <span className="truncate">
              {selectedCompany
                ? localize({
                  en: `Invite people to ${selectedCompany.name}`,
                  zh: `邀请成员加入 ${selectedCompany.name}`,
                })
                : localize({ en: "Invite people", zh: "邀请成员" })}
            </span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild disabled={isEditingOrder}>
          <Link
            to="/company/settings"
            onClick={(event) => {
              if (isEditingOrder) {
                event.preventDefault();
                return;
              }
              closeNavigationChrome();
            }}
          >
            <Settings className="size-4" />
            <span>{localize({ en: "Company settings", zh: "公司设置" })}</span>
          </Link>
        </DropdownMenuItem>
        {session?.session ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => signOutMutation.mutate()}
              disabled={isEditingOrder || signOutMutation.isPending}
            >
              <LogOut className="size-4" />
              <span>
                {signOutMutation.isPending
                  ? localize({ en: "Signing out...", zh: "正在退出..." })
                  : localize({ en: "Sign out", zh: "退出登录" })}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
