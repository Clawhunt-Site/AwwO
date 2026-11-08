// Copying a line to the clipboard (the relay settings' commands, the treg advice's lines). It lived beside the
// 邀请好友 page, which went with the invite codes (the public beta, 2026-11-08).

/** Copies text to the clipboard, through a hidden selection where the clipboard API refuses; false when neither works. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall back to a selection below */ }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  area.remove();
  return copied;
}
