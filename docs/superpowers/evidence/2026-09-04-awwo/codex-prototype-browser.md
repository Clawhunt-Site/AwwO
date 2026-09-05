# Browser readback of the actual Codex frontend output

Verified locally on 2026-09-04, with the final-version refresh at 23:46 Asia/Shanghai.

- Source Agent: `a784236e-c48a-468d-b14f-8392297e0452`.
- Canvas execution: `59376352-1dab-4786-b480-6192051ea67a`.
- Source directory: `C:/tmp/awwo-codex-live-20260904/a784236e-c48a-468d-b14f-8392297e0452`.
- Preview: `http://127.0.0.1:4173/`, served by the generated `python -B server.py --port 4173` on loopback.
- Final `src/app.js` SHA-256: `267dfa0cb5ed2a08811be7a422b8031623e937f382e19b0ab7a9f43d0e14c90e`.

These were real browser interactions with the generated files, not fixture screenshots or injected application state:

1. The page continuously identified demo mode and simulated data. Entering as Owner opened the workspace chooser and the product workspace.
2. Searching for `入职` returned one document. Its detail page showed the published version and Owner editing action.
3. Switching to the customer-support workspace retained the query, cleared the previous results and returned zero matches. The current role changed to Viewer, without document-management or member-management actions.
4. The Viewer dashboard showed three authorized published documents, its scope and timestamp. Unsupported contributor/search-trend metrics were marked as not connected.
5. In `?mode=live`, attempting the identity-service login returned `AUTH_DEPENDENCY_UNAVAILABLE` and did not authenticate the user.
6. In demo mode, a new temporary draft was saved. Attempting publication without category/owner produced `QUALITY_FAILED`; the entered title and body remained intact. Only in-memory demo state was changed.
7. After the last source modification, the page was refreshed at 23:46 and Owner login, workspace selection and the one-result keyword search were rechecked successfully. This refresh cleared the temporary demo document.

Screenshots: `codex-prototype-dashboard.png`, `codex-prototype-live-mode.png`, `codex-prototype-draft-validation.png`, and `codex-prototype-final.png`. The final screenshot is from the explicitly refreshed final version. The earlier screenshots record the preceding interaction checks.

The Codex subprocess had reported that its own browser launch was blocked by the host, so its JSDOM results were not treated as browser evidence. This independent browser pass supplies a bounded visual and interaction check. It does not establish full accessibility compliance, real backend authentication/authorization, deployment or a production-ready SaaS. Markdown is explicitly rendered as safe plain text in this prototype; rich Markdown rendering and several service-dependent capabilities remain unimplemented.

## Readback after automatic frontend rework

At 23:59 on 2026-09-04, after AWW-15/16/17 had completed, the browser loaded the updated frontend files again. Demo login, product-workspace selection and the `入职` search again succeeded with one result. Screenshot: `codex-prototype-rework-final.png`. The independent repair audit in `codex-live-rework.json` matched all eleven reported source hashes and verified the two original reproductions; its 31 model/regression tests and three DOM tests are separate from this browser smoke. The original first-pass run and its evidence were retained.
