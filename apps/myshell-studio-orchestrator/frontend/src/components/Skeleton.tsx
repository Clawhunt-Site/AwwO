interface Props {
  width?: string;
  height?: string;
  borderRadius?: string;
}

/**
 * 加载占位骨架屏。
 * Tailwind v4 从 @theme 自动推导：bg-Cr-Bg-surface-default-v2 等直接用。
 */
export default function Skeleton({ width = '100%', height = '100%', borderRadius }: Props) {
  return (
    <div
      className="bg-linear-to-r from-Cr-Bg-surface-default-v2 from-25% via-Cr-Bg-surface-subtle-v2 via-50% to-Cr-Bg-surface-default-v2 to-75% bg-[length:200%_100%] animate-[shimmer_1.5s_ease-in-out_infinite] rounded-xl-v2"
      style={{
        width,
        height,
        ...(borderRadius ? { borderRadius } : {}),
      }}
    />
  );
}
