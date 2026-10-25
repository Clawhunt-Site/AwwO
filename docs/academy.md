# The AwwO Academy

The Academy is AwwO's tutorial videos, in a dialog any page of the hosted app can open (2026-10-21; owner: 「在awwO做一个分页，
上线教程页面，把我们的Academy的东西装修好，并且做成弹窗」). Every video was recorded on the live AwwO, with Chinese and English
subtitles burned in. Since 2026-10-22 every video plays its motion version (owner: 「按照这个动效标准，全把现有的单个教程加一些
这样的动效处理」): the same recording, narration and length, with an animated title, a chapter opener for each step and a
chapter tracker, spotlights, click ripples, a time-lapse sign with the run's clock, a recap that comes in with its
narration, and quiet sound effects under the narration.

| Section | Videos | Narration | What they show |
| --- | --- | --- | --- |
| Start here (`start`) | 6, about 2 min each | Chinese | One sentence and the canvas assistant writes code, makes a poster, builds a site, writes a plan with a team; then a node opened and changed with the assistant, and the settings centre |
| Inside the flagship cases (`flagship`) | 6 | English | Open the case, see how it was made, copy its canvas as a draft, use what it delivered |
| Build a case, step by step (`build`) | 17 | English | Write the request in four parts, let the canvas assistant build the team, run the canvas, try the result |

The two how-tos added on 2026-10-25 were recorded as the first four were (2026-10-17): on the live AwwO, in the workspace
kept for them, in Chinese and simple mode, with the same tools and motion layer. One opens a node of a three-node canvas
made and run before the take, reads its Task, changes it with the assistant and runs the nodes left again (real runs);
the other walks through the settings centre without changing a setting. The account that records them is an
administrator's: that take hides the entries only administrators see, so it shows what every user sees.
Each how-to's title card numbers it in Start here, 「从这里开始 · n / 6」. The first four said n / 4 and the two new ones
had no number, so later on 2026-10-25 all six were rendered again with that number and nothing else: the same takes,
sound, timing and length, in new files with new posters.

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
recorded again: a new take of those steps, cut into the edit at the same place (spliced in, or the edit built again from its
plan with those beats taken from the new take), rendered as the rest of the motion version, staged under its new sha256 and
put in the entry with the note removed.

A video updated after it was first published logs it in `changes` (the day and the words in both languages, newest
first): its card says **Updated 24 Oct** / **10月24日更新**, and the dialog lists its updates beside it as **更新记录** /
**Updates**. A video rendered again with nothing recorded again (the how-tos' renumbered title cards of 2026-10-25) logs
nothing: its viewers see nothing new to watch. Recorded again in full, as the five flagships were on 2026-10-24 (a new take of the same steps with
`take_flagship.py`, cut from the same edit plan and narration, but for the lines that had to change) and THE LONG CHORD the
same day on Episode I (14 of its 29 lines written again from the case's record, and its copy walked by panning: in the
recording's 1920-px window no zoom shows all 298 nodes at once), it also moves its `recordedOn` to that day. Recorded again
in part, it keeps its `recordedOn`: the 17 build videos' step 3 on 2026-10-25, every agent's Configure done again on a draft
copy of its case, with the steps of the video's own take in today's panel (which asks only for a model: AwwO picks the
engine), the edit built again from its plan with those beats from the new take, and the narration's runtime lines, the
recap's step on it and the two rebuilt cases' closing lines written and voiced again (the old panel showed its runtime row
throughout step 3, not only where the narration named it). A take's draft copy is deleted afterwards (`delete_mine.py`,
which saves it first).

The notes of 2026-10-24 (31, on all 27 videos when they were published) come from that day's audit of every video against
the changelog: the 17 build videos' Configure step (the runtime AwwO now picks itself), the EV plant digital twin and Neon
Circuit racer cases (rebuilt on three.js r186), what the canvas assistant says on a fresh copy of PALLWARD, Umber, Backprop,
Errand and Roost, THE LONG CHORD, now Episode I, with what a copy makes and costs, and in the first four how-tos the links between a
direct task and a plan for the canvas (gone) and the code how-to's recap on refunds. The five fresh-copy notes and THE LONG
CHORD's two went the same day, when those videos were recorded again, and the build videos' 19 on 2026-10-25, when their
step 3 was; the first four how-tos' five remain. THE LONG CHORD's tutorial
now says itself what a copy makes again and costs: `saas-academy.test.tsx` recomputes it from the case canvas's own media
nodes, priced by `mediaCreditsFor` (`backend/internal/app/plans.go`) from that file's price table and plans, and checks the
count against the case's record, so a new price, plan or count that makes the video wrong fails the test. The multipliers
for a setting (a video's length and resolution, a picture's count, size and quality) are mirrored in the test by hand: a
change to those rules in `mediaCreditsFor` needs the same change there. What the how-tos show of the
free plan holds until the promotion ends on 2026-10-29.

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

The files (1.91 GB) are too large for a release. A staged file stays when no catalog names it any more (nothing removes
one); among them are the first cut's (1.39 GB), THE LONG CHORD's first recording (0.06 GB, replaced on 2026-10-21), the
earlier motion versions of the six flagships recorded again on 2026-10-24 (0.46 GB), the 17 build videos' versions from
before their step 3 was recorded again on 2026-10-25 (1.18 GB), the six how-tos' versions from before their title cards
were renumbered (0.10 GB) and nine motion versions staged on 2026-10-22 before their sound was encoded again (0.44 GB). Each is staged once on the host,
outside every release, under `/showcase/staged/academy/<first 16 hex digits of its sha256>.mp4`, checked by its sha256
and never overwritten; the site serves it for any `/showcase/` path the live release lacks, as it serves a film case's
film. Locally, the dev server serves them from `AWWO_STAGED_SHOWCASE/academy/` (`apps/web/scripts/staged-showcase.mjs`).

To add or replace a video: stage the new file first (a new sha256 gives a new name, so a page that loaded the old catalog keeps
playing the old file), then change its entry in `academyCatalog.ts` (sha256, bytes, seconds, `src`) and release the web app. A
new video needs a poster under `apps/web/showcase/academy/` unless it walks through a homepage case.

The dialog loads no video until one is opened, and then only its first bytes (`preload="metadata"`) until it plays.
