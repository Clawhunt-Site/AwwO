import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { createPortal, useAnchoredPosition, useOutsideClose } from './AnchoredLayer';

/**
 * 页面内统一下拉框架（替代原生 <select> / <datalist> 的 macOS 系统菜单）。
 *
 * - `Dropdown`：单选下拉。选项支持图标（任意 ReactNode，含 SVG）、副标题描述、禁用态。
 * - `ComboInput`：自由输入 + 建议菜单（替代 <datalist>）。
 *
 * 菜单经 portal 挂到 body，fixed 定位并随空间自动上/下翻转，
 * 因此不受父容器 overflow 裁剪，但始终在页面内渲染、可完全自定义样式。
 * 纯表现层组件：选项与值仍由调用方（契约/内核数据）提供。
 */

export type DropdownOption = {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** 标签右侧的状态角标（如「未配置」）；与 disabled 不同，带角标的选项仍可点击 */
  badge?: ReactNode;
};

function nextEnabledIndex(options: DropdownOption[], from: number, step: 1 | -1): number {
  let index = from;
  for (let i = 0; i < options.length; i += 1) {
    index = (index + step + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return from;
}

function OptionRow({
  option,
  active,
  selected,
  id,
  onSelect,
  onHover,
}: {
  option: DropdownOption;
  active: boolean;
  selected: boolean;
  id: string;
  onSelect: () => void;
  onHover: () => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // 长菜单里键盘移动高亮时跟随滚动（jsdom 无 scrollIntoView，需守卫）
    if (active) rowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  return (
    <div
      ref={rowRef}
      role="option"
      id={id}
      aria-selected={selected}
      aria-disabled={option.disabled || undefined}
      className={`sc-dropdown-option${active ? ' is-active' : ''}`}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!option.disabled) onSelect();
      }}
      onPointerMove={() => {
        if (!option.disabled) onHover();
      }}
    >
      {option.icon ? <span className="sc-dropdown-option__icon">{option.icon}</span> : null}
      <span className="sc-dropdown-option__body">
        <span className="sc-dropdown-option__label">{option.label}</span>
        {option.description ? (
          <span className="sc-dropdown-option__description">{option.description}</span>
        ) : null}
      </span>
      {option.badge ? <span className="sc-dropdown-option__badge">{option.badge}</span> : null}
      {selected ? <Check size={14} className="sc-dropdown-option__check" aria-hidden="true" /> : null}
    </div>
  );
}

export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  className,
  menuClassName,
  icon,
  placeholder,
  disabled,
  renderValue,
  variant = 'pill',
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  title?: string;
  className?: string;
  menuClassName?: string;
  /** 触发器左侧图标 */
  icon?: ReactNode;
  placeholder?: ReactNode;
  disabled?: boolean;
  /** 自定义触发器上显示的当前值 */
  renderValue?: (selected: DropdownOption | undefined) => ReactNode;
  /** pill=作曲区胶囊；field=表单全宽字段（对应原 .stacked-field/.inline-form 里的 select） */
  variant?: 'pill' | 'field';
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const menuStyle = useAnchoredPosition(open, triggerRef, menuRef);

  const selected = options.find((option) => option.value === value);

  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(open, [triggerRef, menuRef], close);

  const openMenu = () => {
    if (disabled) return;
    const selectedIndex = options.findIndex(
      (option) => option.value === value && !option.disabled,
    );
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : nextEnabledIndex(options, -1, 1));
    setOpen(true);
  };

  useEffect(() => {
    if (open) menuRef.current?.focus({ preventScroll: true });
  }, [open]);

  const selectOption = (option: DropdownOption) => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    if (option.value !== value) onChange(option.value);
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        nextEnabledIndex(options, index, event.key === 'ArrowDown' ? 1 : -1),
      );
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(options, event.key === 'Home' ? -1 : 0, event.key === 'Home' ? 1 : -1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option && !option.disabled) selectOption(option);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    } else if (event.key === 'Tab') {
      // 菜单 portal 在 body 末尾：先把焦点还给触发器再放行默认 Tab，
      // 顺序焦点才会落到触发器的下一个控件（与原生 select 一致）
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu();
    }
  };

  return (
    <span
      className={`sc-dropdown${variant === 'field' ? ' sc-dropdown--field' : ''}${className ? ` ${className}` : ''}`}
      title={title}
    >
      <button
        type="button"
        ref={triggerRef}
        id={`${listId}-trigger`}
        className="sc-dropdown-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${listId}-menu` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        {icon ? <span className="sc-dropdown-trigger__icon">{icon}</span> : null}
        <span className="sc-dropdown-trigger__label">
          {renderValue ? renderValue(selected) : selected?.label ?? placeholder ?? value}
        </span>
        <ChevronDown size={13} className="sc-dropdown-trigger__chevron" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={`${listId}-menu`}
              role="listbox"
              aria-labelledby={`${listId}-trigger`}
              tabIndex={-1}
              className={`sc-dropdown-menu${menuClassName ? ` ${menuClassName}` : ''}`}
              style={menuStyle}
              aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
              onKeyDown={handleMenuKeyDown}
            >
              {options.map((option, index) => (
                <OptionRow
                  key={option.value}
                  option={option}
                  id={`${listId}-${index}`}
                  active={index === activeIndex}
                  selected={option.value === value}
                  onSelect={() => selectOption(option)}
                  onHover={() => setActiveIndex(index)}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

export function ComboInput({
  value,
  onChange,
  suggestions,
  ariaLabel,
  title,
  className,
  menuClassName,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: DropdownOption[];
  ariaLabel?: string;
  title?: string;
  className?: string;
  menuClassName?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // 仅过滤本次打开后用户敲入的文本；聚焦初始展示全部建议
  const [filterText, setFilterText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const menuStyle = useAnchoredPosition(open, inputRef, menuRef);

  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(open, [inputRef, menuRef], close);

  const normalizedFilter = (filterText ?? '').trim().toLowerCase();
  const visible = normalizedFilter
    ? suggestions.filter((option) => {
        const haystack = `${option.value} ${typeof option.label === 'string' ? option.label : ''}`;
        return haystack.toLowerCase().includes(normalizedFilter);
      })
    : suggestions;

  const openMenu = () => {
    if (disabled || suggestions.length === 0) return;
    setFilterText(null);
    setActiveIndex(-1);
    setOpen(true);
  };

  const selectOption = (option: DropdownOption) => {
    setOpen(false);
    onChange(option.value);
    inputRef.current?.focus({ preventScroll: true });
  };

  // 过滤后无匹配时不渲染 listbox，aria-expanded/aria-controls 必须同步收起
  const listboxOpen = open && visible.length > 0;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) {
        event.preventDefault();
        openMenu();
        return;
      }
      if (visible.length > 0) {
        event.preventDefault();
        setActiveIndex((index) =>
          nextEnabledIndex(visible, index, event.key === 'ArrowDown' ? 1 : -1),
        );
      }
    } else if (event.key === 'Enter') {
      if (open && activeIndex >= 0 && visible[activeIndex]) {
        event.preventDefault();
        selectOption(visible[activeIndex]);
      } else {
        setOpen(false);
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
    }
  };

  return (
    <span className={`sc-combo${className ? ` ${className}` : ''}`} title={title}>
      <input
        ref={inputRef}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={listboxOpen}
        aria-autocomplete="list"
        aria-controls={listboxOpen ? `${listId}-menu` : undefined}
        aria-activedescendant={
          listboxOpen && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onFocus={openMenu}
        onBlur={() => setOpen(false)}
        onClick={() => {
          if (!open) openMenu();
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setFilterText(event.target.value);
          setActiveIndex(-1);
          if (!open && suggestions.length > 0) setOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />
      {listboxOpen
        ? createPortal(
            <div
              ref={menuRef}
              id={`${listId}-menu`}
              role="listbox"
              className={`sc-dropdown-menu${menuClassName ? ` ${menuClassName}` : ''}`}
              style={menuStyle}
              // 整个菜单面板（含 padding/滚动区）按下都不抢输入框焦点，
              // 否则 onBlur 会在点击选项前关掉菜单
              onPointerDown={(event) => event.preventDefault()}
            >
              {visible.map((option, index) => (
                <OptionRow
                  key={option.value}
                  option={option}
                  id={`${listId}-${index}`}
                  active={index === activeIndex}
                  selected={option.value === value}
                  onSelect={() => selectOption(option)}
                  onHover={() => setActiveIndex(index)}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
