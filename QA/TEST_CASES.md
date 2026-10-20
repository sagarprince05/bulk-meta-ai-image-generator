# QA Test Suite: ImageRush (Chrome extension)

Baseline recorded 2026-10-19 before any code change: 17 files, ~2.2k lines, 17 automated tests passing.
Statuses: NOT RUN, IN PROGRESS, PASS, FAIL, BLOCKED. Evidence lives in `QA/evidence/` and `QA/RESULTS.md`.

Legend for "How": AUTO = node test runner with fake Chrome; UI = dashboard driven in a browser with a demo shim;
LIVE = real Chrome with the unpacked extension and a logged-in meta.ai tab; STATIC = code/manifest inspection.

| ID | Module | Scenario | Preconditions | Steps | Expected | How |
|---|---|---|---|---|---|---|
| SMK-01 | Build | Manifest and all scripts parse | repo checked out | `node --check` each JS, parse manifest.json | no syntax errors, MV3 manifest valid | STATIC |
| SMK-02 | Build | Automated suite runs green | node 24 | `npm test` | all tests pass | AUTO |
| SMK-03 | Extension | Loads unpacked in Chrome without errors | Chrome dev mode | Load `extension/` | no errors on chrome://extensions, icon appears | LIVE |
| SMK-04 | Dashboard | Toolbar icon opens dashboard | SMK-03 | click icon | dashboard tab opens, badge "Idle" | LIVE |
| SMK-05 | Adapter | Test meta.ai connection | logged in to meta.ai | click "Test meta.ai connection" | reports logged in, chat box found, send button found | LIVE |
| VAL-01 | Validation | Sample 3-prompt file | – | upload samples/test_prompts.json | "3 prompt(s) found", preview lists 3 | AUTO+UI |
| VAL-02 | Validation | Invalid JSON syntax | – | upload `{"prompts":[}` | error with line/column, no preview | AUTO+UI |
| VAL-03 | Validation | Top level is array / empty / null | – | upload `[]`, empty file | clear error messages | AUTO |
| VAL-04 | Validation | Missing prompts / prompts not list / empty list | – | upload each | specific error for each | AUTO |
| VAL-05 | Validation | Prompt missing filename / prompt / empty strings | – | upload | per-prompt errors naming position and id | AUTO |
| VAL-06 | Validation | Duplicate ids | – | two prompts with id 1 | error names both positions | AUTO |
| VAL-07 | Validation | Bad aspect ratios ("wide", "0:1", number) | – | upload | errors; "4 : 3" normalised to "4:3" | AUTO |
| VAL-08 | Validation | Unsafe filenames (`a/b:c*.png`, `CON`, `..x..`) | – | upload | sanitised with warning, extension stripped | AUTO |
| VAL-09 | Validation | Warnings: missing project, missing ids, unknown fields, duplicate filenames | – | upload | file accepted with warnings listed | AUTO+UI |
| VAL-10 | Validation | Non-.json file, >50MB file | – | drop `x.txt` | rejected with message | UI |
| VAL-11 | Validation | BOM prefix, 10,001 prompts | – | upload | BOM accepted; >10,000 rejected | AUTO |
| VAL-12 | Validation | Prompt text preserved byte-for-byte | – | prompt with odd spacing/newlines | stored unchanged | AUTO |
| UI-01 | Upload | Drag-and-drop highlights and accepts file | dashboard open | drag file over zone, drop | zone highlights, validation shown | UI |
| UI-02 | Upload | Preview then confirm loads project | VAL-01 | click "Use these prompts" | stats: total 3, pending 3, Idle | UI |
| UI-03 | Upload | Cancel preview | VAL-01 | click Cancel | preview hidden, nothing loaded | UI |
| UI-04 | Upload | Replace project while running is refused | batch running | upload + confirm | toast asks to stop/pause first | UI |
| UI-05 | Controls | Button enable/disable per state | project loaded | observe in idle/running/paused/stopped/finished | only valid actions enabled | UI |
| UI-06 | Queue | Table columns and status chips | project loaded | inspect | #, ID, filename, prompt, status, preview, actions | UI |
| UI-07 | Queue | Prompt preview expands on click | – | click prompt cell | full text shown, click again collapses | UI |
| UI-08 | Queue | "Show failed only" filter | one failed item | tick box | only failed rows | UI |
| UI-09 | Settings | Dialog shows current values, saves, validates folder | – | open, edit, save | values persist; bad folder chars rejected | UI |
| UI-10 | Summary | Finished dialog with counts and time | batch finished | – | dialog shows completed/failed/skipped/total | UI |
| UI-11 | Security | Prompt containing HTML/script is rendered as text | – | prompt `<img src=x onerror=alert(1)>` | no script runs, text visible | UI |
| UI-12 | Responsive | No horizontal overflow at 460px and 1280px | – | resize | scrollWidth == clientWidth | UI |
| UI-13 | Dashboard | Opened outside extension shows guidance banner | – | open dashboard.html directly | banner, no JS errors | UI |
| Q-01 | Queue | Strict one-at-a-time, file order | 3 prompts | start | never two generations overlapping; order 1,2,3 | AUTO |
| Q-02 | Queue | Prompt sent exactly as written (+ aspect line) | – | start | adapter receives original text | AUTO |
| Q-03 | Queue | Prompt modification only when enabled | – | prefix/suffix set, toggle off/on | unchanged when off; applied when on | AUTO |
| Q-04 | Queue | Retryable failure retried up to maxRetries | adapter fails once | start | attempts=2, completed | AUTO |
| Q-05 | Queue | Non-retryable failure marked FAILED immediately | adapter declines | start | failed, in failed_prompts.json | AUTO |
| Q-06 | Queue | Retry Failed re-runs only failed items | Q-05 | click Retry Failed | completed items untouched | AUTO |
| Q-07 | Queue | Single Retry / Regenerate from row | – | retry index | item re-queued and processed | AUTO |
| Q-08 | Queue | Skip / Unskip | – | skip pending, unskip | status toggles, skipped not processed | AUTO |
| Q-09 | Queue | Pause finishes current item then waits | running | pause mid-item | state pausing then paused; next not started | AUTO |
| Q-10 | Queue | Resume continues from next pending | paused | resume | continues | AUTO |
| Q-11 | Queue | Stop submits nothing more; resume after stop works | running | stop | stopped, remaining pending | AUTO |
| Q-12 | Queue | Start when nothing pending is refused | finished | start | error "Nothing is pending" | AUTO |
| Q-13 | Queue | Auto-pause after N consecutive failures | adapter always fails | start | paused after N, log explains | AUTO |
| Q-14 | Queue | Login required pauses batch | adapter reports login wall | start | paused with login message | AUTO |
| Q-15 | Queue | Delay between images is honoured | delay 1s | start 3 prompts | gaps >= delay | AUTO |
| Q-16 | Queue | Recovery after worker restart | item "generating" in storage | boot new worker | item retried, batch completes, no duplicates | AUTO |
| Q-17 | Queue | Repeated Start clicks do not double-run | – | call start twice quickly | one loop only | AUTO |
| Q-18 | Queue | Clear project | – | clear | state reset, files untouched | AUTO |
| Q-19 | Performance | 100 prompts complete, state updates stay fast | mock adapter | start | finishes; per-item overhead small; storage size sane | AUTO |
| F-01 | Files | Images saved under Downloads/<root>/<Project>/ with JSON filename | – | start | files exist, non-empty, PNG magic bytes | AUTO+LIVE |
| F-02 | Files | No overwrite: duplicates get numbered suffix | two prompts same filename | start | `same.png`, `same (1).png` | AUTO |
| F-03 | Files | Prompt copy saved as `prompts/<name>.txt` with exact text | setting on | start | file matches prompt | AUTO |
| F-04 | Files | Manifest fields and totals correct after every item | – | inspect after each item | id, filename, prompt, status, path, timestamps, error | AUTO |
| F-05 | Files | failed_prompts.json lists only failures | Q-05 | inspect | count and entries match | AUTO |
| F-06 | Files | Download interrupted => item FAILED, not completed | fake download fails | start | failed with reason | AUTO |
| F-07 | Files | Export Generation Report writes timestamped file | project loaded | click Export | report_<ts>.json exists | AUTO |
| F-08 | Files | Project folder name sanitised ("Bible Images" -> Bible_Images) | – | – | folder name | AUTO |
| F-09 | Files | Output format setting: png vs original | adapter returns webp | start | png when convertible, original otherwise, manifest records format | AUTO |
| L-01 | Live | 3 prompts generate on meta.ai and save | logged in | start | 3 PNGs exist and open, manifest correct | LIVE |
| L-02 | Live | Fresh chat per prompt | – | observe | meta.ai reloads to new chat each time | LIVE |
| L-03 | Live | Pause/Resume/Stop during live run | – | press each | behaves as Q-09..Q-11 | LIVE |
| L-04 | Live | Logged-out meta.ai | log out | start | paused with login message, no crash | LIVE |
| L-05 | Live | Browser restart mid-batch | running | close/reopen Chrome | resumes, no duplicate images | LIVE |
| L-06 | Live | Open Output Folder | one image saved | click | file manager opens at file | LIVE |
| SEC-01 | Security | Permissions minimal and host-limited to meta.ai | – | inspect manifest | no `<all_urls>`, no remote code | STATIC |
| SEC-02 | Security | No credentials handled or stored | – | grep code | none | STATIC |
| SEC-03 | Security | Output folder setting cannot escape Downloads | – | set `../x`, `C:\x` | rejected | UI+AUTO |
| SEC-04 | Security | Data URLs / prompts cannot inject into reports | – | prompt with quotes/unicode | valid JSON files | AUTO |
