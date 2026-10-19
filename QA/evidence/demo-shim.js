// UI-test shim: an in-memory stand-in for background.js so the dashboard can be exercised in a plain browser.
import { newProjectState, counts, STATUS, RUN, DEFAULT_SETTINGS, resetForRetry, nextPendingIndex } from "./lib/queue.js";

const state = { project: null, settings: { ...DEFAULT_SETTINGS }, run: { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null }, log: [] };
const listeners = [];
const broadcast = () => setTimeout(() => listeners.forEach((l) => l({ type: "state_changed" })), 0);
const log = (level, message) => { state.log.push({ t: new Date().toISOString(), level, message }); broadcast(); };
const pub = () => ({ ok: true, project: state.project, settings: state.settings, run: state.run, log: state.log, counts: state.project ? counts(state.project.items) : null });
let timer = null;
window.__demoFailNext = false;

function step() {
  if (state.run.state !== RUN.RUNNING) { timer = null; return; }
  const i = nextPendingIndex(state.project.items);
  if (i === -1) { state.run.state = RUN.FINISHED; state.run.finishedAt = new Date().toISOString(); state.run.summary = counts(state.project.items); state.run.currentIndex = -1; log("ok", "Batch finished."); timer = null; return; }
  const it = state.project.items[i];
  it.status = STATUS.GENERATING; it.attempts += 1; it.promptSent = it.prompt; state.run.currentIndex = i;
  log("info", `Image ${i + 1} of ${state.project.items.length}: generating "${it.filename}".`);
  timer = setTimeout(() => {
    if (window.__demoFailNext) { window.__demoFailNext = false; it.status = STATUS.FAILED; it.error = "No image appeared within 180s."; log("error", `${it.filename}: failed`); }
    else { it.status = STATUS.COMPLETED; it.outputPath = `C:\\Users\\you\\Downloads\\Generated_Images\\X\\${it.filename}.png`; it.previewUrl = "icons/icon128.png"; it.completedAt = new Date().toISOString(); log("ok", `Saved ${it.filename}.png.`); }
    state.run.currentIndex = -1;
    broadcast();
    if (state.run.state === RUN.PAUSING) { state.run.state = RUN.PAUSED; timer = null; return; }
    if (state.run.state === RUN.STOPPING) { state.run.state = RUN.STOPPED; timer = null; return; }
    timer = setTimeout(step, 50);
  }, 400);
}

const handlers = {
  get_state: () => pub(),
  load_project: ({ validation, sourceName }) => { state.project = newProjectState(validation, sourceName); state.run = { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null }; state.log = []; log("info", `Loaded ${sourceName}`); return pub(); },
  clear_project: () => { state.project = null; state.run = { state: RUN.IDLE, currentIndex: -1 }; state.log = []; return pub(); },
  update_settings: ({ settings }) => { Object.assign(state.settings, settings); return pub(); },
  start: () => { if (!state.project) return { ok: false, error: "Load a JSON file first." }; if (nextPendingIndex(state.project.items) === -1) return { ok: false, error: "Nothing is pending." }; state.run.state = RUN.RUNNING; state.run.startedAt = state.run.startedAt || new Date().toISOString(); if (!timer) step(); return pub(); },
  pause: () => { if (state.run.state === RUN.RUNNING) state.run.state = state.run.currentIndex >= 0 ? RUN.PAUSING : RUN.PAUSED; if (state.run.state === RUN.PAUSED) { clearTimeout(timer); timer = null; } return pub(); },
  resume: () => handlers.start(),
  stop: () => { if (state.run.state === RUN.RUNNING) state.run.state = state.run.currentIndex >= 0 ? RUN.STOPPING : RUN.STOPPED; else if (state.run.state === RUN.PAUSED) state.run.state = RUN.STOPPED; if (state.run.state === RUN.STOPPED) { clearTimeout(timer); timer = null; } return pub(); },
  retry_item: ({ index }) => { state.project.items[index] = resetForRetry(state.project.items[index]); return handlers.start(); },
  retry_failed: () => { state.project.items = state.project.items.map((it) => (it.status === STATUS.FAILED ? resetForRetry(it) : it)); return handlers.start(); },
  skip_item: ({ index }) => { const it = state.project.items[index]; if (it.status === STATUS.PENDING || it.status === STATUS.FAILED) it.status = STATUS.SKIPPED; return pub(); },
  unskip_item: ({ index }) => { const it = state.project.items[index]; if (it.status === STATUS.SKIPPED) it.status = STATUS.PENDING; return pub(); },
  export_report: () => { log("ok", "Report exported."); return pub(); },
  open_folder: () => ({ ok: true }),
  test_connection: () => ({ ok: true, loggedIn: true, composerFound: true, composerKind: "div", sendButtonFound: true, url: "https://www.meta.ai/" }),
};
window.chrome = { runtime: { lastError: undefined, onMessage: { addListener(l) { listeners.push(l); } }, sendMessage: (msg, cb) => { const h = handlers[msg.type]; const r = h ? h(msg) : { ok: false, error: `no handler ${msg.type}` }; setTimeout(() => cb(r), 0); } } };
window.__demoState = state;
