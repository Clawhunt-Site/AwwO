import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NavigationBar } from "../components/NavigationBar";
import { Sidebar } from "../components/Sidebar";
import { useEnergy } from "../contexts/EnergyContext";
import { useTelegramBackButton, openExternalLink } from "../hooks/useTelegram";
import {
  fetchLibraryAll,
  retryTask,
  deleteTask,
  likeTask,
  reportTaskDownload,
  type LibraryGenerateResult,
} from "../services/api";
import { trackEvent } from "../services/tracking";
import { isHiddenBotSlug } from "../constants/hiddenBots";
import { shareTaskToTelegram } from "../utils/shareTask";
import {
  ArrowRight,
  Download,
  Ellipsis,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import emptyImg from "../assets/empty.png";

export default function Library() {
  const { t } = useTranslation("library");
  const navigate = useNavigate();
  const { energy, init } = useEnergy();
  const [items, setItems] = useState<LibraryGenerateResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewingItem, setViewingItem] = useState<LibraryGenerateResult | null>(
    null,
  );
  const [videoError, setVideoError] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const loadData = useCallback(
    async (
      opts: { isPoll?: boolean; retryCount?: number } = {},
    ): Promise<boolean> => {
      const { isPoll = false, retryCount = 0 } = opts;
      const signal = abortRef.current?.signal;
      try {
        const res = await fetchLibraryAll(signal);
        if (!mountedRef.current) return false;
        setItems(res.generateResults || []);
        setLoading(false);
        setError(null);
        return (res.generateResults || []).some(
          (r) => r.status === "running" || r.status === "queued",
        );
      } catch (err) {
        if (!mountedRef.current || signal?.aborted) return false;
        if (retryCount < 1) {
          await new Promise((r) => setTimeout(r, 1000));
          if (!mountedRef.current || signal?.aborted) return false;
          return loadData({ isPoll, retryCount: 1 });
        }
        if (!isPoll) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
        return false;
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    abortRef.current = new AbortController();
    loadData().then((hasActive) => {
      if (!mountedRef.current) return;
      if (hasActive) {
        pollRef.current = setInterval(async () => {
          const stillActive = await loadData({ isPoll: true });
          if (!stillActive && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }, 5000);
      }
    });
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [loadData]);

  const handleBackFromViewer = useCallback(() => {
    setViewingItem(null);
    setShowActions(false);
    setVideoError(false);
  }, []);
  useTelegramBackButton(viewingItem ? handleBackFromViewer : null);

  const handleRetry = async (taskId: string) => {
    trackEvent('miniapp_result_action', { task_id: taskId, action: 'regenerate' });
    try {
      await retryTask(taskId);
      loadData();
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (taskId: string) => {
    try {
      await deleteTask(taskId);
      setItems((prev) => prev.filter((t) => t.taskId !== taskId));
      if (viewingItem?.taskId === taskId) {
        setViewingItem(null);
        setShowActions(false);
      }
    } catch {
      /* ignore */
    }
  };

  const handleFeedback = async (status: number) => {
    if (!viewingItem) return;
    setShowActions(false);
    // Fire result_action for explicit like / report (dislike=report in Spec).
    // Skip status=0 (toggle-off) to avoid noise.
    if (status === 1 || status === 2) {
      trackEvent('miniapp_result_action', {
        task_id: viewingItem.taskId,
        action: status === 1 ? 'like' : 'report',
      });
    }
    try {
      await likeTask(viewingItem.taskId, status);
      const newStatus =
        status === 1
          ? "ART_TASK_LIKE_STATUS_LIKE"
          : status === 2
            ? "ART_TASK_LIKE_STATUS_DISLIKE"
            : "ART_TASK_LIKE_STATUS_UNSET";
      setItems((prev) =>
        prev.map((t) =>
          t.taskId === viewingItem.taskId ? { ...t, likeStatus: newStatus } : t,
        ),
      );
      setViewingItem((prev) =>
        prev ? { ...prev, likeStatus: newStatus } : null,
      );
    } catch {
      /* ignore */
    }
  };

  const isVideo = (item: LibraryGenerateResult) =>
    item.botType === "video" || item.result?.outputImg?.endsWith(".mp4");

  const getThumb = (item: LibraryGenerateResult) => {
    const r = item.result;
    if (r?.outputPoster) return r.outputPoster;
    if (r?.outputImg) return r.outputImg;
    return r?.inputImg?.[0] || item.imageUrl || "";
  };

  const nav = (
    <>
      <NavigationBar
        onMenuClick={() => setSidebarOpen((prev) => !prev)}
        onEnergyClick={() => navigate("/energy")}
        energy={energy}
        sidebarOpen={sidebarOpen}
      />
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
    </>
  );

  const pageClass =
    "h-full overflow-y-auto pt-12 pb-10 [-webkit-overflow-scrolling:touch]";
  const contentClass = "px-4";
  const titleClass = "text-xl font-semibold text-Cr-text-static-white-v2 my-4";

  if (loading) {
    return (
      <div className={pageClass}>
        {nav}
        <div className={contentClass}>
          <h1 className={titleClass}>{t("library:title")}</h1>
          <div className="p-8 text-center text-Cr-text-subtler-v2">
            {t("common:loading")}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={pageClass}>
        {nav}
        <div className={contentClass}>
          <h1 className={titleClass}>{t("library:title")}</h1>
          <div className="p-8 text-Cr-text-critical-default-v2 text-sm text-center">
            <div className="font-bold mb-2">{t("library:failedToLoad")}</div>
            <div className="break-all opacity-80 mb-4">{error}</div>
            <button
              onClick={() => {
                setError(null);
                setLoading(true);
                abortRef.current = new AbortController();
                loadData();
              }}
              className="py-2.5 px-6 bg-Cr-Bg-brand-bolder-v2 text-Cr-text-static-white-v2 border-none rounded-lg-v2 text-sm font-semibold cursor-pointer"
            >
              {t("common:retry")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={pageClass}>
        {nav}
        <div className={contentClass}>
          <h1 className={titleClass}>{t("library:title")}</h1>
          <div className="flex flex-col items-center justify-center gap-4 h-[calc(100vh-200px)] text-center p-10">
            <div className="flex flex-col items-center gap-3 w-full">
              <img src={emptyImg} alt="" className="w-24 h-24 object-contain" />
              <div className="flex flex-col items-center gap-1.5 max-w-[378px] w-full">
                <div className="text-xl font-medium leading-7 text-Cr-text-default-v2">
                  {t("library:noCreationsYet")}
                </div>
                <div className="text-sm leading-5 text-Cr-text-subtler-v2">
                  {t("library:noCreationsDesc")}
                </div>
              </div>
            </div>
            <button
              className="h-11 px-6 rounded-md-v2 text-Cr-text-static-white-v2 text-base font-medium leading-6 flex items-center justify-center gap-1.5 border-0 cursor-pointer active:opacity-90"
              style={{ backgroundImage: "var(--gradient-dreamy-brand)" }}
              onClick={() => navigate("/")}
            >
              {t("library:browseCharacters")}
              <ArrowRight size={20} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={pageClass}>
      {nav}
      <div className={contentClass}>
        <h1 className={titleClass}>{t("library:title")}</h1>

        <div className="columns-2 gap-2 p-0">
          {items.map((item) => {
            // ── Error card ──
            if (item.status === "error" || item.status === "rejected") {
              return (
                <div
                  key={item.taskId}
                  className="break-inside-avoid mb-2 rounded-lg overflow-hidden cursor-pointer relative transition-transform duration-150 ease-out active:scale-[0.97]"
                >
                  <div className="aspect-[3/4] bg-Cr-Bg-surface-subtle-v2 flex flex-col items-center justify-center gap-2 p-4 text-center">
                    <div className="text-[28px] text-Cr-text-subtler-v2 mb-1">
                      ⚠
                    </div>
                    <div className="text-sm font-medium text-Cr-text-default-v2">
                      {t("library:generationFailed")}
                    </div>
                    <div className="flex flex-col gap-1.5 w-full mt-1">
                      <button
                        className="w-full py-1.5 px-3 rounded-md-v2 text-sm font-medium cursor-pointer border-none bg-white/10 text-Cr-text-static-white-v2"
                        onClick={() => handleRetry(item.taskId)}
                      >
                        {t("common:retry")}
                      </button>
                      <button
                        className="w-full py-1.5 px-3 rounded-md-v2 text-sm font-medium cursor-pointer border-none bg-transparent text-Cr-text-critical-default-v2"
                        onClick={() => handleDelete(item.taskId)}
                      >
                        {"🗑 " + t("common:delete")}
                      </button>
                    </div>
                  </div>
                </div>
              );
            }

            // ── Queued / Running card ──
            if (item.status === "queued" || item.status === "running") {
              const estimate = parseInt(item.estimateTaskDuration) || 300000;
              const elapsed = Date.now() - parseInt(item.startTime);
              const progress =
                Math.min(Math.max(elapsed / estimate, 0.02), 0.95) * 100;
              return (
                <div
                  key={item.taskId}
                  className="break-inside-avoid mb-2 rounded-lg overflow-hidden cursor-pointer relative transition-transform duration-150 ease-out active:scale-[0.97]"
                >
                  <div className="aspect-[3/4] bg-Cr-Bg-surface-subtle-v2 flex flex-col justify-end p-3">
                    <div className="flex flex-col gap-2">
                      <span className="text-sm font-medium text-Cr-text-default-v2">
                        {item.status === "queued"
                          ? t("library:inQueue")
                          : t("library:generatingStatus")}
                      </span>
                      <div className="w-full h-1.5 bg-white/10 rounded-[3px] overflow-hidden">
                        <div
                          className="h-full bg-dreamy-brand-hot-v2 rounded-[3px] transition-[width] duration-500 ease-out"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            // ── Done card ──
            const thumb = getThumb(item);
            const w = parseInt(item.result?.width) || 0;
            const h = parseInt(item.result?.height) || 0;
            const ratio = w && h ? `${w}/${h}` : "3/4";
            return (
              <div
                key={item.taskId}
                className="break-inside-avoid mb-2 rounded-lg overflow-hidden cursor-pointer relative transition-transform duration-150 ease-out active:scale-[0.97]"
                onClick={() => {
                  setVideoError(false);
                  setViewingItem(item);
                  trackEvent('miniapp_task_view', { task_id: item.taskId, status: item.status });
                  // miniapp_result_view — fires once per (task_id, session).
                  // Latency is measured from task startTime to first open, since
                  // the backend does not expose an explicit completion timestamp.
                  const startMs = Number(item.startTime) || 0;
                  trackEvent('miniapp_result_view', {
                    task_id: item.taskId,
                    slug_id: item.slugId,
                    bot_id: item.botId,
                    first_view_latency_ms: startMs ? Math.max(0, Date.now() - startMs) : 0,
                  });
                }}
              >
                {thumb && (
                  <img
                    src={thumb}
                    alt=""
                    className="w-full block object-cover"
                    style={{ aspectRatio: ratio }}
                    loading="lazy"
                  />
                )}
                {item.isAiPick && (
                  <div className="absolute top-1.5 right-1.5 flex items-center gap-1.5 h-[22px] px-2 bg-black/30 [backdrop-filter:blur(16px)] [-webkit-backdrop-filter:blur(16px)] rounded-full text-xs font-medium leading-4 text-white pointer-events-none">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M6.029 1.499a.7.7 0 0 1 1.335 0l1.02 3.341a.7.7 0 0 0 .464.464l3.34 1.02a.7.7 0 0 1 0 1.335l-3.34 1.02a.7.7 0 0 0-.464.464l-1.02 3.341a.7.7 0 0 1-1.335 0l-1.02-3.34a.7.7 0 0 0-.464-.464l-3.341-1.02a.7.7 0 0 1 0-1.336l3.34-1.02a.7.7 0 0 0 .465-.464l1.02-3.341Z"
                        fill="white"
                      />
                      <path
                        d="M10.945.88a.21.21 0 0 1 .41 0l.314 1.027a.21.21 0 0 0 .14.14l1.027.314a.21.21 0 0 1 0 .41l-1.027.314a.21.21 0 0 0-.14.14l-.314 1.027a.21.21 0 0 1-.41 0l-.314-1.027a.21.21 0 0 0-.14-.14L9.462 2.77a.21.21 0 0 1 0-.41l1.027-.314a.21.21 0 0 0 .14-.14L10.945.88Z"
                        fill="white"
                      />
                    </svg>
                    {t("library:aiPick")}
                  </div>
                )}
                {isVideo(item) && (
                  <div className="absolute bottom-1.5 right-1.5 bg-Cr-beta-black-30-v2 rounded-full size-6 flex items-center justify-center text-white pointer-events-none">
                    <svg
                      width="8"
                      height="9"
                      viewBox="0 0 8 9"
                      fill="none"
                      className="ml-0.5"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <foreignObject
                        x="-40"
                        y="-40"
                        width="87.1052"
                        height="89"
                      ></foreignObject>
                      <path
                        data-figma-bg-blur-radius="40"
                        fill-rule="evenodd"
                        clip-rule="evenodd"
                        d="M0.375259 0.0840744C0.606292 -0.0395707 0.886626 -0.0260192 1.10466 0.119334L6.78886 3.90881C6.98653 4.04058 7.10526 4.26243 7.10526 4.5C7.10526 4.73757 6.98653 4.95942 6.78886 5.09119L1.10466 8.88067C0.886626 9.02602 0.606292 9.03957 0.375259 8.91593C0.144226 8.79228 0 8.55151 0 8.28947V0.710527C0 0.448489 0.144226 0.207719 0.375259 0.0840744Z"
                        fill="white"
                      />
                      <defs>
                        <clipPath
                          id="bgblur_0_755_2980_clip_path"
                          transform="translate(40 40)"
                        >
                          <path
                            fill-rule="evenodd"
                            clip-rule="evenodd"
                            d="M0.375259 0.0840744C0.606292 -0.0395707 0.886626 -0.0260192 1.10466 0.119334L6.78886 3.90881C6.98653 4.04058 7.10526 4.26243 7.10526 4.5C7.10526 4.73757 6.98653 4.95942 6.78886 5.09119L1.10466 8.88067C0.886626 9.02602 0.606292 9.03957 0.375259 8.91593C0.144226 8.79228 0 8.55151 0 8.28947V0.710527C0 0.448489 0.144226 0.207719 0.375259 0.0840744Z"
                          />
                        </clipPath>
                      </defs>
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Full-screen Viewer ── */}
      {viewingItem && (
        <div className="fixed inset-0 z-[500] bg-Cr-Bg-soft-v2 flex flex-col">
          <div className="flex-1 flex items-center justify-center py-4 px-2 min-h-0">
            {videoError ? (
              <div className="w-full h-full relative flex items-center justify-center">
                {(viewingItem.result.outputPoster || viewingItem.imageUrl) && (
                  <img
                    src={
                      viewingItem.result.outputPoster || viewingItem.imageUrl
                    }
                    alt=""
                    className="w-full h-full object-contain absolute inset-0 opacity-30 blur-lg"
                  />
                )}
                <div className="relative z-[1] flex flex-col items-center text-center py-8 px-6 max-w-[280px]">
                  <div className="mb-4 opacity-70">
                    <svg
                      width="40"
                      height="40"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#f5f5f6"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v4M12 16h.01" />
                    </svg>
                  </div>
                  <div className="text-lg font-semibold text-Cr-text-default-v2 mb-2">
                    {t("library:formatNotSupported")}
                  </div>
                  <div className="text-sm text-Cr-text-subtler-v2 leading-normal mb-5">
                    {t("library:videoFallbackDesc")}
                  </div>
                  <button
                    className="py-3 px-6 rounded-md-v2 bg-gradient-to-br from-dreamy-crimson-from-v2 to-dreamy-crimson-to-v2 text-white text-base font-medium border-none cursor-pointer flex items-center gap-2 active:opacity-85"
                    onClick={() =>
                      openExternalLink(viewingItem.result.outputImg)
                    }
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                    {t("library:openInBrowser")}
                  </button>
                </div>
              </div>
            ) : isVideo(viewingItem) ? (
              <video
                src={viewingItem.result.outputImg}
                poster={viewingItem.result.outputPoster}
                className="max-w-full max-h-full object-contain rounded-lg w-full"
                controls
                autoPlay
                loop
                playsInline
                onError={() => {
                  setVideoError(true);
                  trackEvent('miniapp_format_not_supported', {
                    task_id: viewingItem.taskId,
                    slug_id: viewingItem.slugId,
                    bot_name: viewingItem.botName,
                    video_url: viewingItem.result.outputImg,
                    has_preview: !!viewingItem.result?.outputPreview,
                  });
                }}
              />
            ) : (
              <img
                src={viewingItem.result.outputImg}
                alt=""
                className="max-w-full max-h-full object-contain rounded-lg"
              />
            )}
          </div>
          {viewingItem.botName &&
            viewingItem.slugId &&
            !isHiddenBotSlug(viewingItem.slugId) && (
              <button
                className="flex items-center gap-2 mx-4 mb-2 py-2 px-3 bg-Cr-beta-black-20-v2 [backdrop-filter:blur(12px)] [-webkit-backdrop-filter:blur(12px)] border border-Cr-beta-white-12-v2 rounded-lg cursor-pointer self-start active:opacity-80"
                onClick={() => {
                  setViewingItem(null);
                  navigate(`/bot?slug_id=${viewingItem.slugId}`);
                }}
              >
                <img
                  src={viewingItem.imageUrl || ""}
                  alt=""
                  className="w-6 aspect-3/4 rounded object-cover shrink-0 bg-white/5"
                />
                <span className="text-sm leading-5 font-normal text-Cr-text-static-white-v2 max-w-[146px] whitespace-nowrap overflow-hidden text-ellipsis">
                  {viewingItem.botName}
                </span>
              </button>
            )}
          <div className="flex gap-2 py-3 px-4 pb-[calc(env(safe-area-inset-bottom,16px)+12px)]">
            <button
              className="flex-1 h-12 px-C-button-xl-padding-v2 rounded-md-v2 bg-CCr-button-brand-bg_default-v2 hover:bg-CCr-button-brand-bg_hover-v2 active:bg-CCr-button-brand-bg_active-v2 text-CCr-button-brand-fg_default-v2 text-base font-medium leading-6 flex items-center justify-center gap-1.5 border-0 cursor-pointer"
              onClick={() => {
                trackEvent('miniapp_result_action', { task_id: viewingItem.taskId, action: 'save' });
                void reportTaskDownload(viewingItem.taskId);
                openExternalLink(viewingItem.result.outputImg);
              }}
            >
              <Download size={20} strokeWidth={2} />
              {t("library:download")}
            </button>
            <button
              className="w-12 h-12 rounded-md-v2 bg-CCr-button-tertiary-bg_default-v2 flex items-center justify-center flex-shrink-0 border-none cursor-pointer active:opacity-90"
              onClick={() => {
                if (viewingItem) {
                  trackEvent('miniapp_result_action', { task_id: viewingItem.taskId, action: 'share' });
                  void shareTaskToTelegram(
                    viewingItem.taskId,
                    init?.userInfo?.userId ?? "",
                  );
                }
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
            </button>
            <button
              className="w-12 h-12 rounded-md-v2 bg-CCr-button-tertiary-bg_default-v2 flex items-center justify-center flex-shrink-0 border-none cursor-pointer active:opacity-90"
              onClick={() => setShowActions(true)}
            >
              <Ellipsis size={24} strokeWidth={2} className="text-white" />
            </button>
          </div>

          {showActions && (
            <>
              <div
                className="fixed inset-0 z-[600] bg-black/50"
                onClick={() => setShowActions(false)}
              />
              <div className="fixed bottom-0 left-0 right-0 z-[601] bg-Cr-Bg-soft-v2 rounded-t-2xl-v2 py-3 px-4 pb-[calc(env(safe-area-inset-bottom,16px)+16px)] animate-[slideUp_0.25s_ease]">
                <div className="w-11 h-1 rounded-[5px] bg-dreamy-neutral-button-active-v2 mx-auto mb-4" />
                <div className="flex gap-3 mb-3">
                  <button
                    className="flex-1 h-[76px] rounded-md-v2 bg-Cr-Bg-surface-default-v2 border-none flex flex-col items-center justify-center gap-1.5 text-Cr-text-default-v2 text-base font-normal cursor-pointer active:opacity-85"
                    onClick={() =>
                      handleFeedback(
                        viewingItem.likeStatus?.includes("LIKE") &&
                          !viewingItem.likeStatus?.includes("DISLIKE")
                          ? 0
                          : 1,
                      )
                    }
                  >
                    {(() => {
                      const liked =
                        viewingItem.likeStatus?.includes("LIKE") &&
                        !viewingItem.likeStatus?.includes("DISLIKE");
                      return (
                        <ThumbsUp
                          size={24}
                          strokeWidth={1.5}
                          color="currentColor"
                          fill={liked ? "currentColor" : "none"}
                        />
                      );
                    })()}
                    {t("library:like")}
                  </button>
                  <button
                    className="flex-1 h-[76px] rounded-md-v2 bg-Cr-Bg-surface-default-v2 border-none flex flex-col items-center justify-center gap-1.5 text-Cr-text-default-v2 text-base font-normal cursor-pointer active:opacity-85"
                    onClick={() =>
                      handleFeedback(
                        viewingItem.likeStatus?.includes("DISLIKE") ? 0 : 2,
                      )
                    }
                  >
                    {(() => {
                      const disliked =
                        viewingItem.likeStatus?.includes("DISLIKE");
                      return (
                        <ThumbsDown
                          size={24}
                          strokeWidth={1.5}
                          color="currentColor"
                          fill={disliked ? "currentColor" : "none"}
                        />
                      );
                    })()}
                    {t("library:dislike")}
                  </button>
                </div>
                <button
                  className="w-full h-12 rounded-md-v2 bg-Cr-Bg-surface-default-v2 border-none flex items-center justify-center gap-2 text-Cr-text-critical-default-v2 text-base font-normal cursor-pointer mb-4 active:opacity-85"
                  onClick={() => handleDelete(viewingItem.taskId)}
                >
                  <Trash2
                    size={18}
                    strokeWidth={1.5}
                    className="text-[#ef3b2e]"
                  />
                  {t("common:delete")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
