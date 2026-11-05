// The browser tab's and history's name for each page. Every page used to keep saas.html's one title, so a reader with
// three canvases, the settings and the admin open saw five tabs called the same; a page now names itself first.
import { useEffect } from 'react';

/** A page's title: its own names first, AwwO last (「画布名 · AwwO」, 「账号安全 · 设置 · AwwO」). */
export function pageTitle(...names: string[]): string {
  return [...names.map(name => name.trim()).filter(Boolean), 'AwwO'].join(' · ');
}

/** Names the page in the tab while it shows. null leaves the name to a page drawn inside this one, whose effect runs
 *  first (React runs a child's effects before its parent's). */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => { if (title !== null) document.title = title; }, [title]);
}
