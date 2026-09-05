import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Plus, X } from 'lucide-react';
import { Popover } from './Popover';

/**
 * 聊天区右侧「对话面板」宿主框架 —— 浏览器式多标签页（tab）任务面板。
 *
 * 设计目标：侧边栏是一个**多功能任务集成面**，顶部一条类似浏览器的 tab 栏，
 * 可在多个独立任务窗口之间切换、新建、关闭。每个 tab 有自己的类型（kind）：
 *   - `web`    沙箱网页预览（WebView）
 *   - `file`   单文件预览
 *   - `plan`   当前对话关联 run 的任务列表
 *   - （未来）`terminal` 等
 *
 * 同类 tab 可多开（真·浏览器多实例），每个 tab 是独立实例（有唯一 id 与各自载荷）。
 *
 * - `ConversationTab`：tab 实例的判别联合类型（载荷随 kind 不同）。
 * - `ConversationTabHost`：tab 栏 + 内容区的抽屉壳。tab 渲染、标题/图标、
 *   可新建类型与空状态一律由调用方（App）通过 props 提供 —— 纯表现层，
 *   不持有任何业务语义，也不自己拉数据。
 */

export type TabKind = 'web' | 'file' | 'plan' | 'automation';

/** tab 实例：判别联合，载荷随 kind 而定。`web`/`file` 携带各自定位信息，`plan` 无额外载荷。 */
export type ConversationTab =
  | { id: string; kind: 'web'; url: string }
  | { id: string; kind: 'file'; runId: string; path: string }
  | { id: string; kind: 'plan' }
  | { id: string; kind: 'automation' };

/** 「+」新建菜单里的一个可建 tab 类型 */
export type NewTabOption = {
  kind: TabKind;
  label: string;
  icon: LucideIcon;
  /** 占位/未就绪的类型（如未来的终端）禁用并给出提示 */
  disabled?: boolean;
  hint?: string;
};

/** 每个 tab 的显示元信息，由调用方按 kind + 载荷动态计算（如网页用域名、文件用文件名） */
export type TabMeta = { icon: LucideIcon; title: string };

export function ConversationTabHost({
  tabs,
  activeTabId,
  id,
  className,
  shellRef,
  tabMeta,
  renderContent,
  emptyState,
  newTabOptions,
  actions,
  labels,
  resizeHandle,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onClose,
}: {
  tabs: ConversationTab[];
  activeTabId: string | null;
  /** 元素 id，供触发器 aria-controls 关联 */
  id: string;
  className?: string;
  shellRef?: RefObject<HTMLElement | null>;
  /** 计算单个 tab 的图标与标题 */
  tabMeta: (tab: ConversationTab) => TabMeta;
  /** 渲染激活 tab 的内容 */
  renderContent: (tab: ConversationTab) => ReactNode;
  /** 无任何 tab 时的空状态 */
  emptyState: ReactNode;
  newTabOptions: NewTabOption[];
  /** tab 栏右侧、关闭按钮左边的调用方动作位（如「打开设置」「在 Finder 中显示」） */
  actions?: ReactNode;
  /** 面板左缘的拖拽调整宽度手柄（纯表现层，由调用方提供） */
  resizeHandle?: ReactNode;
  labels: {
    /** 整个面板的 aria 区域名 */
    region: string;
    /** 关闭整个侧边栏 */
    close: string;
    /** 「+」按钮 aria */
    newTab: string;
    /** 「+」弹出菜单 aria */
    newTabMenu: string;
    /** 关闭单个 tab（会拼上 tab 标题） */
    closeTab: string;
  };
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: (kind: TabKind) => void;
  /** 关闭整个抽屉 */
  onClose: () => void;
}) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const [menuOpen, setMenuOpen] = useState(false);
  const newTabButtonRef = useRef<HTMLButtonElement | null>(null);

  // 只在焦点位于抽屉内时响应 Escape，不做全局监听
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <section
      ref={shellRef}
      id={id}
      className={className}
      role="complementary"
      aria-label={labels.region}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {resizeHandle}
      <div className="tab-bar">
        <div className="tab-strip" role="tablist" aria-label={labels.region}>
          {tabs.map((tab) => {
            const meta = tabMeta(tab);
            const Icon = meta.icon;
            const selected = activeTab?.id === tab.id;
            return (
              <div key={tab.id} className={`tab-chip${selected ? ' active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={selected ? `${id}-content` : undefined}
                  className="tab-chip-main"
                  title={meta.title}
                  onClick={() => onSelectTab(tab.id)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className="tab-chip-title">{meta.title}</span>
                </button>
                <button
                  type="button"
                  className="tab-chip-close"
                  aria-label={`${labels.closeTab}: ${meta.title}`}
                  onClick={() => onCloseTab(tab.id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <button
            ref={newTabButtonRef}
            type="button"
            className="tab-new"
            aria-label={labels.newTab}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
          <Popover
            open={menuOpen}
            anchorRef={newTabButtonRef}
            ariaLabel={labels.newTabMenu}
            className="tab-new-menu"
            onClose={() => setMenuOpen(false)}
          >
            <ul className="tab-new-list" role="menu" aria-label={labels.newTabMenu}>
              {newTabOptions.map((option) => {
                const OptionIcon = option.icon;
                return (
                  <li key={option.kind} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="tab-new-item"
                      disabled={option.disabled}
                      onClick={() => {
                        onNewTab(option.kind);
                        setMenuOpen(false);
                      }}
                    >
                      <OptionIcon size={15} aria-hidden="true" />
                      <span className="tab-new-item-label">{option.label}</span>
                      {option.hint ? <span className="tab-new-item-hint">{option.hint}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Popover>
        </div>
        <div className="tab-bar-actions">
          {actions}
          <button className="icon-button" type="button" aria-label={labels.close} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </div>
      <div id={`${id}-content`} className="tab-content">
        {activeTab ? renderContent(activeTab) : emptyState}
      </div>
    </section>
  );
}
