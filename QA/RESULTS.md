# QA Results, 2026-10-19

Build under test: `extension/` at commit-less working copy (no git). Baseline before fixes: 17 automated tests passing.
After fixes: 29 automated tests (`npm test`) and 32 dashboard UI checks pass. Live meta.ai checks are partly done.

Evidence: `QA/evidence/automated_tests_output.txt`, `QA/evidence/ui-test-script.js` (+ `demo-shim.js`),
`QA/evidence/dashboard_ui_after_tests.jpg`, `QA/evidence/live_meta_ai_logged_in.jpg`.

## Summary

| Area | Cases | PASS | FAIL | BLOCKED | NOT RUN |
|---|---|---|---|---|---|
| Smoke (SMK) | 5 | 3 | 0 | 2 | 0 |
| Validation (VAL) | 12 | 12 | 0 | 0 | 0 |
| UI (UI) | 13 | 13 | 0 | 0 | 0 |
| Queue (Q) | 19 | 19 | 0 | 0 | 0 |
| Files (F) | 9 | 9 | 0 | 0 | 0 |
| Live (L) | 6 | 0 | 0 | 6 | 0 |
| Security (SEC) | 4 | 4 | 0 | 0 | 0 |

## Defects found

| ID | Severity | Priority | Where | Problem | Status |
|---|---|---|---|---|---|
| DEF-01 | Medium | High | content.js / background.js | Live meta.ai images are served from `scontent.xx.fbcdn.net` with no CORS headers. The content script's `fetch` fails and the canvas is tainted, so PNG conversion was impossible and files would always be saved as WebP. | FIXED: worker now fetches the CDN (host permission added for `*.fbcdn.net`, `*.cdninstagram.com`) and converts to PNG with OffscreenCanvas; falls back to the original format with a log warning. Regression suite green. Needs live confirmation (L-01). |
| DEF-02 | Low | Medium | content.js | Error detection matched the generic phrase "try again", which can appear in Meta AI's own suggestion text and could mark a slow generation as failed. | FIXED: pattern narrowed to "please try again later" / "something went wrong" / "an error occurred". |
| DEF-03 | Low | Low | content.js | No way to confirm from the page whether the adapter is loaded (content-script globals are invisible to page scripts). | FIXED: adapter sets `data-bulkgen-adapter="<version>"` on `<html>`. |
| OBS-01 | Info | – | Live | Meta AI returned **two** responses, each with one 2048x1152 WebP image, for a single prompt. Default behaviour saves the largest (first) one; "Save every variant" saves both as `name.png` and `name_v2.png`. | Documented, no change. |
| OBS-02 | Info | – | Live | The 16:9 hint in the prompt text was honoured by Meta AI (2048x1152 output). | – |
| OBS-03 | Info | – | Live | `C:\Users\Prince\Downloads\Generated_Images` does not exist, so the user's own 3-prompt run has not produced files yet. The extension that was loaded is also older than the fixed build (DEF-01..03). | Reload required. |

## Detailed results

| ID | Status | Actual result / evidence |
|---|---|---|
| SMK-01 | PASS | `node --check` clean for all scripts; manifest parses; MV3, module worker. |
| SMK-02 | PASS | 29/29 (`automated_tests_output.txt`). |
| SMK-03 | BLOCKED | Needs the fixed build reloaded in Chrome (chrome://extensions is not readable by automation). |
| SMK-04 | BLOCKED | As above; needs the dashboard URL (`chrome-extension://<id>/dashboard.html`). |
| SMK-05 | PASS (UI shim) / BLOCKED (live) | Alert shows "Logged in: yes", chat box, send button. Live page inspection confirms a `div[contenteditable][role=textbox]` composer and a button with aria-label "Send", which the adapter's discovery rules match. |
| VAL-01..12 | PASS | validation.test.mjs + UI drops: counts, per-prompt errors with position and id, aspect-ratio normalisation, filename sanitising, BOM, 10,001-limit, byte-exact prompt. |
| UI-01..13 | PASS | ui-test-script.js results: dragover highlight, .txt rejected, bad JSON blocks preview, warnings listed, cancel, preview of 3, load, button states in idle/running/paused/finished/stopped, columns, prompt expand, failed filter, settings save and validation, summary dialog, XSS rendered as text (`window.__xss` never set), no horizontal overflow at 264px and 1265px, guidance banner outside the extension. |
| Q-01..19 | PASS | queue.test.mjs + qa.test.mjs: strict serial processing (overlap assertion), exact prompt + aspect line, prefix/suffix only when enabled, retry up to maxRetries, non-retryable → FAILED, Retry Failed only touches failures, row Retry/Regenerate, Skip/Unskip, Pause finishes current item, Resume, Stop, "Nothing is pending", auto-pause after N failures, login wall pause, 1s delay honoured, restart recovery with no duplicate files, double Start runs once, Clear, 100 prompts in ~6s with capped log and compact storage. |
| F-01..09 | PASS | PNG magic bytes verified; `same.png` + `same (1).png` + `same (2).png`; prompt copies byte-exact; manifest fields/totals after every item; failed_prompts.json; interrupted download → FAILED; report_<ts>.json; `Bible Images` → `Bible_Images`; webp kept when "original". |
| L-01 | BLOCKED | Partial: a live prompt was typed and sent by replicating the adapter's steps in the user's Chrome; two 2048x1152 WebP images appeared in ~20s. End-to-end save through the extension not yet run with the fixed build. |
| L-02..L-06 | BLOCKED | Need the reloaded extension and its dashboard URL. |
| SEC-01 | PASS | Permissions: storage, downloads, downloads.ui, tabs, alarms, scripting, unlimitedStorage; hosts limited to meta.ai and Meta's image CDNs; no remote scripts; default MV3 CSP. |
| SEC-02 | PASS | No credential handling anywhere; all `innerHTML` writes pass user data through `escapeHtml` (UI-11 confirms). |
| SEC-03 | PASS | `../escape` and `C:\x` rejected for the output folder (UI + background accepts only a relative subfolder). |
| SEC-04 | PASS | Quotes, backslashes, HTML and Devanagari/emoji in prompts give valid JSON reports and exact `.txt` copies. |

## How to finish the live part

1. `chrome://extensions` → the extension's **Reload** button (the fixed build changed `manifest.json`).
2. Open <https://www.meta.ai> and stay logged in.
3. Click the toolbar icon → copy the dashboard tab's URL and share it, or just run `samples/test_prompts.json` and report.
