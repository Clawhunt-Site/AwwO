# The AwwO Academy

The Academy is AwwO's tutorial videos, in a dialog any page of the hosted app can open (2026-10-21; owner: 「在awwO做一个分页，
上线教程页面，把我们的Academy的东西装修好，并且做成弹窗」). Every video was recorded on the live AwwO, with Chinese and English
subtitles burned in. Since 2026-10-22 every video plays its motion version (owner: 「按照这个动效标准，全把现有的单个教程加一些
这样的动效处理」): the same recording, narration and length, with an animated title, a chapter opener for each step and a
chapter tracker, spotlights, click ripples, a time-lapse sign with the run's clock, a recap that comes in with its
narration, and quiet sound effects under the narration.

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

## When AwwO changes under a video

A video stays as it was recorded, so the live AwwO can come to differ from what it shows. Each such difference is a note
in the video's catalog entry (`notes`, since 2026-10-24): where the span that shows it starts (`at`, whole seconds of the
video), the day AwwO changed (`since`) and what to do now, in both languages. The dialog lists a video's notes under it as
**录制之后的变化** / **Changed since recording**; each note's time plays the video from there. A note goes when its span is
recorded again: a new take, spliced into the edit at the same place, rendered as the rest of the motion version, staged under
its new sha256 and put in the entry with the note removed.

A video updated after it was first published logs it in `changes` (the day and the words in both languages, newest
first): its card says **Updated 24 Oct** / **10月24日更新**, and the dialog lists its updates beside it as **更新记录** /
**Updates**. Recorded again in full, as the five flagships were on 2026-10-24 (a new take of the same steps with
`take_flagship.py`, cut from the same edit plan and narration, but for the lines that had to change), it also moves its
`recordedOn` to that day. A take's draft copy is deleted afterwards (`delete_mine.py`, which saves it first).

The notes of 2026-10-24 (31, on all 27 videos when they were published) come from that day's audit of every video against
the changelog: the 17 build videos' Configure step (the runtime AwwO now picks itself), the EV plant digital twin and Neon
Circuit racer cases (rebuilt on three.js r186), what the canvas assistant says on a fresh copy of PALLWARD, Umber, Backprop,
Errand and Roost, THE LONG CHORD, now Episode I, with what a copy makes and costs, and in the four how-tos the links between a
direct task and a plan for the canvas (gone) and the code how-to's recap on refunds. The five fresh-copy notes went the same
day, when those videos were recorded again; 26 notes on 22 videos remain. A cost in a note is the case canvas's own media nodes priced by
`mediaCreditsFor` (`backend/internal/app/plans.go`): `saas-academy.test.tsx` recomputes THE LONG CHORD's from that file's price
table and plans, and checks its count against the case's record. What the how-tos show of the free plan holds until the
promotion ends on 2026-10-29.

## Code

- `apps/web/src/saas/academyCatalog.ts`: the videos, in order. Each has an id, a section, its case (`caseId`), the narration's
  language, the day it was recorded, a title and a summary in both languages, its length, its file's size and sha256, a
  poster (a case's video shows its case's cover, `/showcase/<footage>.jpg`), its notes, if any, and its updates
  (`changes`), if it was updated after it was first published.
- `apps/web/src/saas/Academy.tsx`: `AcademyProvider` (in `SaaSApp`, around every page) and `AcademyLauncher` (`header`, `menu`,
  `landing`). The dialog itself, `AcademyDialog.tsx`, loads only when it opens.
- `apps/web/src/saas/academyLink.ts`: reading and writing `?academy`.
- Tests: `apps/web/tests/saas-academy.test.tsx` (the catalog's files, wording, agent counts and order; the dialog; the links).

## The videos are staged, not released

The files (1.71 GB) are too large for a release. A staged file stays when no catalog names it any more (nothing removes
one); among them are the first cut's (1.39 GB), THE LONG CHORD's first recording (0.06 GB, replaced on 2026-10-21), the
five flagships' earlier motion versions (0.38 GB) and nine motion versions staged on 2026-10-22 before their sound was
encoded again (0.44 GB). Each is staged once on the host,
outside every release, under `/showcase/staged/academy/<first 16 hex digits of its sha256>.mp4`, checked by its sha256
and never overwritten; the site serves it for any `/showcase/` path the live release lacks, as it serves a film case's
film. Locally, the dev server serves them from `AWWO_STAGED_SHOWCASE/academy/` (`apps/web/scripts/staged-showcase.mjs`).

To add or replace a video: stage the new file first (a new sha256 gives a new name, so a page that loaded the old catalog keeps
playing the old file), then change its entry in `academyCatalog.ts` (sha256, bytes, seconds, `src`) and release the web app. A
new video needs a poster under `apps/web/showcase/academy/` unless it walks through a homepage case.

The dialog loads no video until one is opened, and then only its first bytes (`preload="metadata"`) until it plays.
