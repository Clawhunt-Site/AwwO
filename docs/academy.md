# The AwwO Academy

The Academy is AwwO's tutorial videos, in a dialog any page of the hosted app can open (2026-10-21; owner: 「在awwO做一个分页，
上线教程页面，把我们的Academy的东西装修好，并且做成弹窗」). Every video was recorded on the live AwwO, with Chinese and English
subtitles burned in.

| Section | Videos | Narration | What they show |
| --- | --- | --- | --- |
| Start here (`start`) | 4, about 2 min each | Chinese | One sentence and the canvas assistant writes code, makes a poster, builds a site, writes a plan with a team |
| Inside the flagship cases (`flagship`) | 6 | English | Open the case, see how it was made, copy its canvas as a draft, use what it delivered |
| Build a case, step by step (`build`) | 17 | English | Write the request in four parts, let the canvas assistant build the team, run the canvas, try the result |

## Where it opens

- The workspace home page's top bar: **Academy** (**教程** in Chinese), between the account and the appearance buttons.
- **More options** on every signed-in page, canvas pages included.
- The signed-out landing page: a button before the language switch.
- A link: `?academy` opens it, `?academy=<video id>` opens that video (a case's video has its case's id, e.g.
  `?academy=the-long-chord`). While it is open, the address follows it with `history.replaceState`; closing it takes its part
  out again. An unknown id opens the library.

A case's video has **Open the case**. On a page with the case library (the workspace home page, the landing page) it closes
the Academy and opens the case there: the library then shows every case, and closing the case gives the focus back to its card.
On other pages it is a link to the workspace's home page with `?case=<case id>`, which the case library follows once and then
takes out of the address (`caseLink.ts`). That link works on its own too, so a case can be shared.

## Code

- `apps/web/src/saas/academyCatalog.ts`: the videos, in order. Each has an id, a section, its case (`caseId`), the narration's
  language, the day it was recorded, a title and a summary in both languages, its length, its file's size and sha256, and a
  poster (a case's video shows its case's cover, `/showcase/<footage>.jpg`).
- `apps/web/src/saas/Academy.tsx`: `AcademyProvider` (in `SaaSApp`, around every page) and `AcademyLauncher` (`header`, `menu`,
  `landing`). The dialog itself, `AcademyDialog.tsx`, loads only when it opens.
- `apps/web/src/saas/academyLink.ts`: reading and writing `?academy`.
- Tests: `apps/web/tests/saas-academy.test.tsx` (the catalog's files, wording, agent counts and order; the dialog; the links).

## The videos are staged, not released

The files (1.39 GB) are too large for a release. Each is staged once on the host, outside every release, under
`/showcase/staged/academy/<first 16 hex digits of its sha256>.mp4`, checked by its sha256 and never overwritten; the site
serves it for any `/showcase/` path the live release lacks, as it serves a film case's film. Locally, the dev server serves
them from `AWWO_STAGED_SHOWCASE/academy/` (`apps/web/scripts/staged-showcase.mjs`).

To add or replace a video: stage the new file first (a new sha256 gives a new name, so a page that loaded the old catalog keeps
playing the old file), then change its entry in `academyCatalog.ts` (sha256, bytes, seconds, `src`) and release the web app. A
new video needs a poster under `apps/web/showcase/academy/` unless it walks through a homepage case.

The dialog loads no video until one is opened, and then only its first bytes (`preload="metadata"`) until it plays.
