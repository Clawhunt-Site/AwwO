import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  LogOut,
  Megaphone,
  type LucideIcon,
  UserRound,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { useLocalizedText } from "@/i18n/localized";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "../context/SidebarContext";
import { useEmbeddedHost } from "../context/EmbeddedHostContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { resolveContentUrl } from "../api/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { SidebarServerInfo } from "./SidebarServerInfo";

const PROFILE_SETTINGS_PATH = "/company/settings/instance/profile";
const DOCS_URL = "https://docs.paperclip.ing/";
const FEEDBACK_URL = "https://paperclip.ing/feedback";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  version?: string | null;
}

interface MenuActionProps {
  label: string;
  description: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}

function deriveInitials(name: string) {
  if (/[\u3400-\u9fff]/.test(name)) {
    return name.trim().slice(0, 1);
  }
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function deriveUserSlug(name: string | null | undefined, email: string | null | undefined, id: string | null | undefined) {
  const candidates = [name, email?.split("@")[0], email, id];
  for (const candidate of candidates) {
    const slug = candidate
      ?.trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return "me";
}

function MenuAction({ label, description, icon: Icon, onClick, href, external = false }: MenuActionProps) {
  const className =
    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/60 dark:hover:bg-muted/35";

  const content = (
    <>
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </>
  );

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={className} onClick={onClick}>
          {content}
        </a>
      );
    }

    return (
      <Link to={href} className={className} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function SidebarAccountMenu({
  deploymentMode,
  open: controlledOpen,
  onOpenChange,
  version,
}: SidebarAccountMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const localize = useLocalizedText();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const embeddedHost = useEmbeddedHost();
  const isEmbedded = Boolean(embeddedHost);
  const rail = collapsed && !peeking;
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  const rawDisplayName = session?.user.name?.trim();
  const displayName = rawDisplayName === "Board"
    ? localize({ en: "Board", zh: "看板" })
    : rawDisplayName || localize({ en: "Board", zh: "看板" });
  const secondaryLabel =
    session?.user.email?.trim() || (
      deploymentMode === "authenticated"
        ? localize({ en: "Signed in", zh: "已登录" })
        : localize({ en: "Local workspace board", zh: "本地工作区看板" })
    );
  const accountBadge = deploymentMode === "authenticated"
    ? localize({ en: "Account", zh: "账号" })
    : localize({ en: "Local", zh: "本地" });
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <div className="border-t border-r border-border bg-background px-3 py-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground dark:hover:bg-muted/35"
            aria-label={localize({ en: "Open account menu", zh: "打开账号菜单" })}
          >
            <Avatar size="sm">
              {session?.user.image ? <AvatarImage src={resolveContentUrl(session.user.image)} alt={displayName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className={cn("min-w-0 flex-1 truncate", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}>{displayName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          className="w-[277px] max-w-[calc(100vw-1rem)] overflow-hidden rounded-t-2xl rounded-b-none border-border p-0 shadow-2xl"
        >
          <div className="h-24 bg-muted" />
          <div className="-mt-8 px-4 pb-4">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border-4 border-popover bg-popover p-0.5 shadow-sm">
                <Avatar size="lg">
                  {session?.user.image ? <AvatarImage src={resolveContentUrl(session.user.image)} alt={displayName} /> : null}
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </div>
              <div className="min-w-0 flex-1 pt-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-foreground">{displayName}</h2>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {accountBadge}
                  </span>
                </div>
                <p className="truncate text-sm text-muted-foreground">{secondaryLabel}</p>
                {version && !isEmbedded ? (
                  <p className="mt-1 text-xs text-muted-foreground">Paperclip v{version}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 space-y-1">
              <MenuAction
                label={localize({ en: "View profile", zh: "查看资料" })}
                description={localize({ en: "Open your activity, task, and usage ledger.", zh: "打开你的活动、任务和用量记录。" })}
                icon={UserRound}
                href={profileHref}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label={localize({ en: "Edit profile", zh: "编辑资料" })}
                description={localize({ en: "Update your display name and avatar.", zh: "更新显示名称和头像。" })}
                icon={UserRoundPen}
                href={PROFILE_SETTINGS_PATH}
                onClick={closeNavigationChrome}
              />
              {!isEmbedded ? (
                <>
                  <MenuAction
                    label={localize({ en: "Documentation", zh: "文档" })}
                    description={localize({ en: "Open documentation in a new tab.", zh: "在新标签页打开文档。" })}
                    icon={BookOpen}
                    href={DOCS_URL}
                    external
                    onClick={() => setOpen(false)}
                  />
                  <MenuAction
                    label={localize({ en: "Feedback", zh: "反馈" })}
                    description={localize({ en: "Share feedback or report an issue.", zh: "分享反馈或报告问题。" })}
                    icon={Megaphone}
                    href={FEEDBACK_URL}
                    external
                    onClick={() => setOpen(false)}
                  />
                </>
              ) : null}
              <ThemeToggle variant="menu-action" onAfterToggle={() => setOpen(false)} />
              {deploymentMode === "authenticated" ? (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-destructive/10",
                    signOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={() => signOutMutation.mutate()}
                  disabled={signOutMutation.isPending}
                >
                  <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {signOutMutation.isPending
                        ? localize({ en: "Signing out...", zh: "正在退出..." })
                        : localize({ en: "Sign out", zh: "退出登录" })}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {localize({ en: "End this browser session.", zh: "结束此浏览器会话。" })}
                    </span>
                  </span>
                </button>
              ) : null}
              <SidebarServerInfo />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
