# Feedback assistant

Every page of the hosted AwwO, signed in or not, has an AI feedback assistant in its bottom-left corner (owner,
2026-11-09). A person says what went wrong; the assistant asks for what an engineer needs and writes a report; one press
sends it to the support inbox, `support@clawhunt.store` in production, at once. Nothing is kept in AwwO's database: the
email is the record.

## What a person sees

- **The button.** A 反馈 / Feedback pill in the window's bottom-left corner. Pages say where it must not go
  (`apps/web/src/saas/feedbackPlacement.ts`): `data-feedback-avoid="beside"` moves it to the right of a column that
  holds controls (the canvas assistant, the model library), `data-feedback-avoid="above"` lifts it over a toolbar (the
  board's view tools), and `data-feedback-slot` keeps it a place of its own (the home's rail, under the account card,
  where it is one of the rail's rows). Where no room is left, as on a phone whose assistant panel fills the width, it
  steps away until there is; while one of the app's own modal dialogs is open (an `aria-modal="true"` element on screen
  or a `<dialog>` shown as a modal), the button and the panel step away too, and the conversation waits under it.
- **The panel.** The assistant greets, offers four starting points, and answers each message. As soon as it can, it
  writes the report (title, category, severity, summary, steps, expected, actual), which the panel shows before
  anything is sent; adding to the conversation has it written again. **发送给 AwwO 团队 / Send to the AwwO team** sends
  it; **不用整理，直接发送给团队 / Send it to the team as it is** sends the person's own words without a report. Up to
  three screenshots can be added or pasted; the page redraws each as a JPEG of at most 330 KB. A visitor may leave an
  email address for the reply. The receipt names the report (`FB-<UTC date>-<six letters and digits>`) and where the
  reply will go.
- **When something is missing.** If the assistant does not answer, the panel says so and the person's words can still
  be sent. If the site cannot send mail (no inbox or relay here, or the relay refused), the panel offers the person's
  own mail client with the report written into it, and a copy to the clipboard.
- The conversation lives in the page and in the tab's `sessionStorage` (`awwo.feedback.v1`), so moving to another page
  keeps it; a report once sent is not kept. Signing out forgets it, and one another person left in the tab (the site
  says who is here each time the panel opens) is dropped before anything of it can be sent. A page that opens on the
  panel leaves the focus where it was; only opening it takes the focus into it.

## What the report carries

The email is plain text (quoted-printable UTF-8) with the screenshots attached. It holds the summary, the reporter (the
signed-in account's name, email and id, or a visitor's network address and optional contact), the page's address with
only the parameters that say where the person was (`tenant`, `canvas`, `view`, `section`, `account`, `case`, `tab`,
`node`: an invitation or reset token never goes), the browser, window, screen, language, time zone, interface mode and
theme, the web build and the API revision, the last script errors and failed API requests the page met
(`apps/web/src/saas/feedbackDiagnostics.ts`, eight of each, in memory only), and the conversation word for word.
`Reply-To` is the account's address, or the visitor's, so the team answers by replying. The panel says what is sent
before anything is.

## API

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/feedback` | anyone | `available` (an inbox and a relay are set), `assistant` (the platform has a worker to ask), `signedIn`, the account's `email`, `supportEmail` |
| `POST /api/v1/feedback/assistant` | anyone | `{messages, locale, page}` → `{reply, ready, report?}`; 503 `assistant_unavailable` / `assistant_busy` when it cannot answer |
| `POST /api/v1/feedback` | anyone | `{messages, report, contact, locale, context, attachments}` → `{id}`; sent within the request |

A session the request carries names the sender; one that ended makes a visitor, who can still send (a report never
waits on a sign-in). Both writes are same-origin only, like every API write.

The assistant is one completion on the router's runtime (Pi, else OpenAI Agents), thinking off, at most 1,600 output
tokens and 25 s, reading the latest of the conversation only (8 messages, 8,000 characters). The worker's slots are its
runs' first: one answer at a time for the whole deployment, and none while fewer than three of the worker's slots are
free (the assistant router may take one), so people chatting at once can never hold the slots a run needs; none either
while a release holds the worker. Its model is
`AWWO_FEEDBACK_MODEL`, else the operator's planner model (`AWWO_PLANNER_MODEL`), else the worker's default where that
costs nothing (the assistant router's rule); a Bedrock model needs the worker's Converse bridge (`computerBedrock`).
Personal-credential deployments (the local edition) have no platform model, so their panel sends words only. The call
is the platform's: no workspace allowance counts it, and its text is never logged. Its answer is read as models write
it: the first JSON object holding a `reply`, with the words around it left out, plain double quotes and control
characters left raw inside its texts escaped (Haiku quotes a Chinese word with plain marks, which refused the release's
first live answer on 2026-11-10), and a report's field of another type left empty; the prompt asks for “” or 「」.

Limits, in memory per API process (a restart forgets them): per person (an account, else a network address, an IPv6
one by its /64) 8 answers a minute and 80 a day (30 for a visitor who is not signed in), one at a time; for the
deployment one answer at a time and 1,000 a day (what the operator's model may cost, whoever asks: past it a report is
still sent, without the assistant); 6 reports an hour and 20 a day per person, 300 a day for the deployment, at most 4
handed to the relay at once (a pool of their own: password recovery's mail slots are never taken). A report the relay
refused is not counted; one it took is sent, whatever the connection's close says. The same report sent again within
10 minutes (a retry whose answer was lost) gets the first one's id and is not mailed twice. Requests stay under the
edge's 2 MB: 16 messages, 2,000 characters each and 16,000 in all; three JPEG or PNG pictures, 450 KB each and 1 MB
together.

A visitor's contact address becomes the email's `Reply-To` unchecked: anyone may type anyone's address, so a reply to a
signed-out report goes to whoever was named. The summary is written by the assistant in the page, which the server
only checks for size and shape, so the email's "written up by the feedback assistant" line is what the page said.

## Configuration

| Variable | development | staging | production |
| --- | --- | --- | --- |
| `AWWO_SUPPORT_EMAIL` | unset: no reports sent (the panel offers the person's mail) | a staging inbox, or unset | unset: `support@clawhunt.store`; `off` sends none |
| `AWWO_FEEDBACK_MODEL` | optional | optional | optional; unset uses `AWWO_PLANNER_MODEL` |
| `AWWO_SMTP_*` | unset | staging relay | the relay password recovery already uses (Resend, TLS on 465 in production since before 2026-11-09) |

Reports go through `smtpSend` (`backend/internal/app/account_security.go`), the transport password recovery uses: TLS
only (465, or STARTTLS on 587), envelope and `From` address `AWWO_SMTP_FROM` (shown as "AwwO Feedback"). A test
environment never mails the real inbox by default: only production falls back to `support@clawhunt.store`.

## Tests

`backend/internal/app/feedback_test.go` (the settings, the model's answers, the address kept, the mail's headers, body
and attachments, refusals, limits and resends, the model call and the worker's slots it leaves, what the model reads,
the status, and with PostgreSQL the signed-in sender and an ended session) and
`apps/web/tests/saas-feedback-assistant.test.tsx` (the conversation, the report and the receipt, words without the
assistant, a visitor's address, the mail fallback, a failed send kept, a conversation restored without the focus taken,
another person's conversation dropped, Send while an answer is coming, Escape while composing, sign-out, the app's own
dialogs, the failed requests noted, the button's place).
