# ImageRush (Chrome extension)

Hosted dashboard: <https://bulk-meta-ai-image-generator-web.vercel.app> (needs the extension installed once).

Upload one JSON file with 3, 50 or 500 prompts, press **Start**, and the extension generates each image
one at a time through **your own Meta AI session** and saves them into one organised folder.

It is free to use and needs no server: everything runs inside the browser of the person using it, with their
own meta.ai login. Nothing is uploaded anywhere except the prompt text you send to meta.ai yourself.

## Install (for anyone)

1. Download this project folder (or just the `extension/` folder).
2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder.
4. Open <https://www.meta.ai> in a tab and log in (the extension never logs in for you).
5. Click the extension's toolbar icon to open the dashboard.

To share it without the developer-mode step, publish the `extension/` folder to the Chrome Web Store
(one-time developer registration) and give people the store link.

## Use

1. **Upload** your `.json` file (drag and drop, or choose). The file is validated and previewed first,
   with the number of prompts found and any problems listed.
2. Press **Use these prompts**, then **Start Generation**.
3. Watch the dashboard: current prompt, "Image 4 of 50", status per prompt, preview, log.
4. **Pause** finishes the current image and waits. **Resume** continues with the next pending prompt.
   **Stop** submits nothing further. **Retry Failed** re-queues only the failed prompts.
5. Images land in `Downloads/Generated_Images/<Project_Name>/` with:
   - `<filename>.png` for every successful prompt (existing files are never overwritten;
     duplicates become `name (1).png`, `name (2).png`, ...),
   - `prompts/<filename>.txt` with the exact original prompt,
   - `generation_manifest.json` (id, filename, prompt, status, path, timestamps, error),
   - `failed_prompts.json`.
6. **Open Output Folder** shows the folder in your file manager. **Export Generation Report** writes a
   timestamped copy of the manifest.

Progress is saved after every image. If Chrome is closed or crashes, reopen the dashboard: completed images are
kept, an interrupted one is retried, and a running batch continues.

### JSON format

```json
{
  "project": "Bible Images",
  "prompts": [
    { "id": 1, "filename": "creation_of_world", "prompt": "Create a cinematic ...", "aspect_ratio": "16:9" }
  ]
}
```

`filename` and `prompt` are required. `id` and `aspect_ratio` are optional. Prompts are sent exactly as written.
Because the meta.ai chat has no aspect-ratio control, the ratio is appended as a plain line
("Aspect ratio: 16:9"); turn that off in Settings if you prefer.

### Settings

Delay between images, retries, timeout, auto-pause after repeated failures, output folder name (inside Downloads),
PNG or original format, prompt copies, fresh chat per prompt, saving every variant Meta AI returns, and an
explicit opt-in to add a prefix/suffix to prompts.

## How it talks to Meta AI, and the limits

Meta has two offerings:

| Option | Cost | Used here |
|---|---|---|
| Meta Model API (`muse-image-1.0`, `POST https://api.meta.ai/v1/images/generations`) | $0.01 per image | No (you asked for a free tool) |
| meta.ai website, logged in | Free | Yes, browser-assisted |

The extension does only what a person does by hand: types the prompt into the chat box, presses send, waits
for the picture, then saves it. It does **not** bypass logins, CAPTCHAs, or rate limits. If meta.ai asks you
to log in or shows a usage limit, the batch pauses and tells you.

Things to know:

- Meta's terms restrict automated use of its products. Use this at your own risk on your own account and keep the
  delay between images reasonable (the default is 8 seconds).
- The adapter finds the chat box and images by their role and size, not by fixed class names, so it survives
  small layout changes. If Meta changes the page a lot, generation will fail with a clear error and
  **Test meta.ai connection** on the dashboard will show what it could and could not find.
- Saving goes through Chrome's download system, so files are always under your **Downloads** folder.
  A browser extension cannot write to arbitrary folders without that. Change the subfolder name in Settings,
  or set Chrome's download location to the drive you want.
- Images are converted to PNG in the browser when possible; if Meta's image host blocks that, the original
  format (usually JPEG or WebP) is saved instead and recorded in the manifest.

## Desktop app (Windows .exe, no extension needed)

Download: <https://github.com/sagarprince05/bulk-meta-ai-image-generator/releases/latest>

`desktop/` is an Electron app with the Meta AI browser built in. Users install `ImageRush-Setup-<version>.exe`
(or run the portable exe), log in to Meta AI once inside the app's own window, and everything else works the same
as the website: type/attach prompts, optional AI prompt writing (through the website's API, no key in the app),
and images saved straight into a folder of their choice (default `Desktop\ImageRush\<Project>\`).

```bash
cd desktop
npm install
npm start          # run locally (copies web/ into desktop/renderer first)
npm run dist       # builds dist/ImageRush-Setup-<version>.exe and ImageRush-Portable-<version>.exe
```

The installer is unsigned, so Windows SmartScreen shows "Unknown publisher" the first time
("More info" → "Run anyway"). A code-signing certificate removes that warning.

## Provider architecture

- `extension/lib/validation.js`: JSON parsing and validation (pure).
- `extension/lib/queue.js`: queue state, retry policy, recovery, manifest builders (pure).
- `extension/background.js`: persistent queue runner, downloads, reports, Pause/Resume/Stop.
- `extension/content.js`: the **meta.ai provider adapter**. It implements one message, `generate`
  (prompt in, image bytes out). A different provider (for example the paid Meta Model API or another site) is a
  second adapter answering the same message; nothing else changes.
- `extension/dashboard.*`: the user interface.

## Tests

```bash
npm test
```

Runs 17 tests with a fake Chrome runtime and a real temporary download folder: JSON validation, strict
one-at-a-time processing, success and failure paths, retries, pause/resume/stop, skip, duplicate file naming,
"download never landed" detection, auto-pause, login detection, and recovery after a restart. The live meta.ai
step is verified by hand with `samples/test_prompts.json` (three prompts).
