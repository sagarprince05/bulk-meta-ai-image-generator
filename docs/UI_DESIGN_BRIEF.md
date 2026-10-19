# UI Design Brief: Bulk Meta AI Image Generator

Use this document to design a new interface (for example in Google Stitch). Section 1 is a ready-to-paste
prompt; the rest is the full detail the design must cover. The app is a **single-page web dashboard**
(desktop-first, responsive down to phone width) plus a tiny browser-extension popup that is not part of this brief.

---

## 1. Ready-to-paste Stitch prompt

> Design a clean, modern, desktop-first single-page web app called **"Bulk Meta AI Image Generator"**.
> Purpose: a user uploads one JSON file containing many image prompts (3 to 500), clicks Start, and the app
> generates each image one by one through the user's own Meta AI account and saves every image into a folder on
> the user's computer. Free tool, no server, nothing uploaded.
>
> Layout, top to bottom:
> 1. **Header**: app logo + name, one-line tagline, right side: "Test meta.ai connection" and "Settings" buttons.
> 2. **Setup card** with three status tiles, each with a coloured status dot (green ok / amber warning / red error),
>    a title, a one-line explanation and small action buttons: (a) Browser extension: "Download extension", "How to
>    install", "Re-check"; (b) Output folder: "Choose folder", "Forget"; (c) Meta AI login: link to meta.ai.
> 3. **Upload card**: large drag-and-drop zone for a .json file with "choose a file" link and a "download a sample"
>    link; below it a validation banner (success green / warnings amber / errors red with a bullet list) and a
>    **preview list** of the parsed prompts (id, filename, aspect ratio, prompt text) with "Cancel" and
>    "Use these prompts" buttons.
> 4. **Project dashboard card**: run-state badge (Idle, Running, Pausing, Paused, Stopping, Stopped, Finished);
>    six stat tiles: Project name, Total prompts, Completed (green), Pending, Failed (red), Skipped; a progress bar
>    with text "12 of 50 processed (24%)"; a "Now generating" panel showing "Image 13 of 50 — filename", the
>    prompt text and status; a control row: primary "Start Generation", "Pause", "Resume", "Stop" (danger),
>    then "Retry Failed", "Export Generation Report", "Clear project" (ghost). A small hint line with the output
>    folder path.
> 5. **Prompt queue card**: a table with columns #, ID, Filename, Prompt (2-line clamp, expands on click),
>    Status chip (Pending grey, Generating blue, Completed green, Failed red, Skipped grey), Preview thumbnail,
>    Actions (Retry / Regenerate / Skip / Unskip small buttons). Failed rows show the error text under the prompt.
>    A "Show failed only" checkbox in the card header.
> 6. **Activity log card**: monospace scrolling log with coloured lines (info, ok, warn, error) and a Hide button.
> 7. **Settings modal** (form): delay between images, retries per prompt, wait before retry, generation timeout,
>    pause after N failures, image format (PNG / original), and checkboxes: save .txt copy of each prompt, fresh
>    chat per prompt, save every variant, append aspect ratio to prompt, allow prompt modification (with prefix
>    and suffix text fields). Cancel / Save buttons.
> 8. **Batch finished modal**: counts Completed, Failed, Skipped, Total, elapsed time, folder path, Close button.
> 9. **Toast** notifications at the bottom centre.
>
> Style: calm, professional, rounded cards, soft borders, 12px radius, subtle shadows, system font. Provide both
> light and dark themes. Accent colour blue (#2563EB); success green, danger red, warning amber. Show three
> states of the page: empty (nothing loaded), running (image 13 of 50 in progress, mixed row statuses), finished
> (summary modal open). Also show a 390px mobile version where stat tiles wrap and the table becomes stacked cards.

---

## 2. Product summary

| Item | Detail |
|---|---|
| Name | Bulk Meta AI Image Generator |
| Type | Static single-page web app (HTML/CSS/JS), hosted on Vercel, plus a Chrome/Brave/Edge extension that it talks to |
| Live URL | https://bulk-meta-ai-image-generator-web.vercel.app |
| Users | Creators who need many AI images from a list of prompts (e.g. 50 Bible-story scenes for a video) |
| Core promise | Upload one JSON, click Start, come back to a folder full of named images and a manifest |
| Cost | Free; uses the user's own meta.ai login in their browser |
| Platforms | Desktop browsers (Chrome, Brave, Edge). Must stay usable on a phone for monitoring progress |

## 3. User flow

1. Open site → see setup status (extension installed? folder chosen? logged in to meta.ai?).
2. First time: download + install extension, choose an output folder (e.g. Desktop), log in to meta.ai in another tab.
3. Drop a JSON file → instant validation → preview → confirm.
4. Start → images generate one at a time; dashboard shows "Image N of M", status per row, thumbnails, log.
5. Pause / Resume / Stop at any time; failed rows can be retried individually or all at once.
6. Finished → summary modal; folder contains images, `prompts/*.txt`, `generation_manifest.json`, `failed_prompts.json`.
7. Reload or browser restart → progress is restored; "Resume" continues from the next pending prompt.

## 4. Screens / sections and their states

### 4.1 Header
- Logo (blue rounded square with image glyph), title, tagline.
- Buttons: `Test meta.ai connection` (ghost), `Settings` (ghost).

### 4.2 Setup card ("1. One-time setup")
Three tiles, each: status dot + title + description + actions.

| Tile | Dot states | Actions |
|---|---|---|
| Browser extension (bridge to meta.ai) | green "Extension found (version 1.3.0)" / red "Extension not found…" | Download extension (.zip), How to install (expands a 4-step list), Re-check |
| Output folder on your computer | green "Saving into 'Desktop'" / amber "No folder chosen, images go to Downloads/Generated_Images/<Project>/" / amber "Folder remembered, click to grant access again" | Choose folder (e.g. Desktop), Forget |
| Logged in to meta.ai | grey unknown / green yes / red no | link to meta.ai |

### 4.3 Upload card ("2. Upload prompts")
- Drop zone (dashed border, highlights on drag-over). Text: "Drop a .json file here or choose a file", small format hint, "download a sample" link.
- Validation banner: ok (green, "3 prompt(s) found. The file looks good."), warn (amber, "N prompt(s) found, with notes:" + list), error (red, "The file cannot be used." + list). Example messages:
  - `Prompt #2 (id 2): missing required field "filename".`
  - `Prompt #5: aspect_ratio "wide" must look like "16:9" (two positive whole numbers).`
  - `Filename "noahs_ark" is used by prompts #2, #7. Later images get a number suffix.`
- Preview panel: title `Project "Bible Images" with 3 prompt(s). Review, then confirm.`, ordered list of prompts (id chip, bold filename, aspect ratio, prompt text in muted colour), buttons Cancel / **Use these prompts** (primary).

### 4.4 Project dashboard card ("3. Project dashboard")
- Badge states: Idle (grey), Running (blue), Pausing… (amber), Paused (amber), Stopping… (amber), Stopped (red), Finished (green).
- Stat tiles: Project, Total prompts, Completed (green number), Pending, Failed (red number), Skipped.
- Progress bar + text `12 of 50 processed (24%)`.
- "Now generating" panel: `Image 13 of 50 — moses_red_sea`, prompt text (scrollable, max ~4 lines), `Generating… (attempt 1)`, optional preview thumbnail on the right.
- Controls and when enabled:

| Button | Enabled when |
|---|---|
| Start Generation (primary) | project loaded, state Idle/Finished/Stopped, pending items exist |
| Pause | Running |
| Resume | Paused or Stopped, pending items exist |
| Stop (danger text) | Running, Pausing, Paused |
| Retry Failed | at least one failed |
| Export Generation Report | project loaded |
| Clear project (ghost) | project loaded, not running |

- Hint lines: `Images are saved to Desktop/Bible_Images/ along with generation_manifest.json and failed_prompts.json.` and `Keep this tab open while generating…`

### 4.5 Prompt queue card ("4. Prompt queue")
- Header checkbox "Show failed only".
- Table columns: #, ID, Filename (+ saved file name and aspect ratio in small muted text), Prompt (2-line clamp; click expands; failed error in red below), Status chip (+ "2 attempts" small text), Preview (96x60 thumbnail or "saved"), Actions.
- Row actions by status: Failed → Retry, Skip; Completed → Regenerate; Pending → Skip; Skipped → Unskip.
- Active row (currently generating) is highlighted.
- Empty state: "Upload a JSON file to see the queue."
- Mobile: rows become stacked cards.

### 4.6 Activity log card
Monospace, ~240px tall, auto-scroll, line colours: info (default), ok (green), warn (amber), error (red). Example lines:
```
[10:42:58] Image 1 of 3: generating "creation_of_world" (attempt 1).
[10:43:31] Saved creation_of_world.png.
[10:43:31] Waiting 8s before the next prompt.
[10:44:10] noahs_ark: No image appeared within 180s. (will retry)
[10:47:02] Paused after 3 failures in a row. Check the meta.ai tab, then press Resume.
```

### 4.7 Settings modal
Fields (with defaults): Delay between images (8 s), Retries per prompt (2), Wait before a retry (15 s), Generation timeout (180 s), Pause after N failures in a row (3, 0 = never), Image format (PNG / Original). Checkboxes: Save a .txt copy of each prompt (on), Start a fresh meta.ai chat for every prompt (on), Save every image variant (off), Append "Aspect ratio: W:H" to each prompt (on), Allow prompt modification (off) + Prompt prefix / Prompt suffix text inputs. Footer note: "Prompts are sent exactly as written unless prompt modification is enabled." Buttons: Cancel, Save.

### 4.8 Batch finished modal
Title "Batch finished", project name, grid: Completed, Failed, Skipped, Total, Time (e.g. 14m 32s), note with folder path and "Use Retry Failed to try the failed prompts again." Button Close.

### 4.9 Toasts
Bottom centre, dark pill, 4 s. Examples: "Prompts loaded. Press Start Generation when ready.", "Settings saved.", "Stop or pause the running batch before loading a new file."

## 5. Data model (what the UI displays)

```json
{
  "project": { "name": "Bible Images", "sourceName": "test_prompts.json", "items": [
    { "position": 1, "promptId": 1, "filename": "creation_of_world", "prompt": "Create a cinematic...",
      "aspectRatio": "16:9", "status": "completed", "attempts": 1, "error": null,
      "outputPath": "Desktop/Bible_Images/creation_of_world.png", "format": "png", "width": 2048, "height": 1152,
      "previewUrl": "blob:...", "startedAt": "2026-10-19T10:42:58Z", "completedAt": "2026-10-19T10:43:31Z" }
  ]},
  "run": { "state": "running", "currentIndex": 12, "consecutiveFailures": 0, "startedAt": "...", "finishedAt": null,
           "summary": { "total": 50, "completed": 12, "failed": 1, "skipped": 0, "pending": 37 } },
  "settings": { "delaySeconds": 8, "maxRetries": 2, "retryBackoffSeconds": 15, "generationTimeoutSeconds": 180,
                "pauseAfterConsecutiveFailures": 3, "outputFormat": "png", "savePromptCopies": true,
                "newChatPerPrompt": true, "saveAllVariants": false, "includeAspectRatioInPrompt": true,
                "modifyPrompts": false, "promptPrefix": "", "promptSuffix": "" },
  "log": [ { "t": "2026-10-19T10:42:58Z", "level": "info", "message": "Image 1 of 3: generating ..." } ]
}
```

Item statuses: `pending`, `generating`, `completed`, `failed`, `skipped`.
Run states: `idle`, `running`, `pausing`, `paused`, `stopping`, `stopped`, `finished`.

## 6. Input file format (shown in the drop zone hint and sample link)

```json
{
  "project": "Bible Images",
  "prompts": [
    { "id": 1, "filename": "creation_of_world", "prompt": "Create a cinematic ...", "aspect_ratio": "16:9" }
  ]
}
```

## 7. Visual language (current)

- Font: system UI stack, 14px base, headings 15–18px.
- Colours (light): background #F4F6FA, card #FFFFFF, text #1A1F2B, muted #667085, border #E3E7EE, primary #2563EB,
  success #15803D on #DCFCE7, danger #B91C1C on #FEE2E2, warning #B45309 on #FEF3C7, info #1D4ED8 on #DBEAFE.
- Dark theme: background #0F1420, card #171D2B, text #E6E9F0, muted #98A2B3, border #2A3344.
- Radius 12px cards / 8px buttons / pill chips. Max content width 1240px, 24px side gutters (16px on phone).
- Icons: simple line icons; app icon is a blue rounded square with a picture glyph.

## 8. Constraints for the new design

- Keep it one page; sections may become tabs or a sidebar, but setup → upload → run → review order must stay obvious.
- The queue must handle 500 rows (virtual scroll or pagination is fine).
- Every interactive element above must exist with the same meaning; names can change.
- Must work at 390px width without horizontal scrolling.
- Accessibility: visible focus states, colour is never the only status indicator (keep text labels on chips).
- Do not add login, accounts or cloud features: the tool is local-only by design.

## 9. Implementation note (for after the design)

The current UI lives in `web/index.html`, `web/app.css`, `web/app.js`. The logic references elements by id
(`dropzone`, `run-badge`, `stat-*`, `btn-*`, `queue-body`, `settings-form`, etc.). A new design can keep those ids
to drop in without logic changes, or the JS can be remapped afterwards.
