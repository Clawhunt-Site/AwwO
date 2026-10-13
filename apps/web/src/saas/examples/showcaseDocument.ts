const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A model-generated page with the files its run's image, video and 3D nodes made put in place. The page names each one
 * as `<node id>/<file>` (as a canvas run hands it over), in its markup or in markup its script writes, sometimes after
 * `./` or `/`; every such name becomes the file's data: URL. Nothing else in the page changes.
 */
export function showcasePage(page: string, media: Readonly<Record<string, string>>): string {
  let html = page;
  for (const [reference, url] of Object.entries(media)) {
    html = html.replace(new RegExp(`(?:\\./|/)?${escapeRegExp(reference)}`, 'g'), () => url);
  }
  return html;
}
