// Links to ClawHunt's privacy policy on the site the signed-in identity names (`clawhuntSiteURL`), drawn only where that
// is an https URL. The policy is on the site's /legal, after its Terms of Service, so /legal alone opens on the Terms;
// each link names where in the policy it opens, by the site's own ids: #sec-privacy is the policy's own element (the
// site's footer and its contents link it), #s-privacy-c8 its clause 08 (ClaudeFableNote.tsx; clause 07 links it too).

/** The site without its trailing slashes; '' unless it is an https URL. */
export function httpsSite(site: string | null | undefined): string {
  const base = typeof site === 'string' ? site.trim().replace(/\/+$/, '') : '';
  return /^https:\/\//.test(base) ? base : '';
}

/** The privacy policy, opened at its top (its title and "Last updated"); '' unless the site is an https URL. */
export function privacyPolicyPageURL(site: string | null | undefined): string {
  const base = httpsSite(site);
  return base ? `${base}/legal#sec-privacy` : '';
}
