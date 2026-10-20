// Pure queue/state helpers shared by the background worker, the dashboard and the tests.

export const STATUS = Object.freeze({
  PENDING: "pending",
  GENERATING: "generating",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
});

export const RUN = Object.freeze({
  IDLE: "idle", // no batch running
  RUNNING: "running",
  PAUSING: "pausing", // finish current item, then wait
  PAUSED: "paused",
  STOPPING: "stopping", // finish current item, then stop
  STOPPED: "stopped",
  FINISHED: "finished",
});

export const DEFAULT_SETTINGS = Object.freeze({
  delaySeconds: 3,
  maxRetries: 2,
  retryBackoffSeconds: 10,
  generationTimeoutSeconds: 180,
  pauseAfterConsecutiveFailures: 3,
  outputFormat: "png", // "png" or "original"
  outputRoot: "Generated_Images", // relative to the browser's Downloads folder
  savePromptCopies: true,
  modifyPrompts: false,
  promptPrefix: "",
  promptSuffix: "",
  includeAspectRatioInPrompt: true,
  newChatPerPrompt: true,
  saveAllVariants: false,
});

export function buildPromptText(item, settings) {
  // Prompts go out exactly as written unless the user explicitly turned on modification.
  let text = item.prompt;
  if (settings.modifyPrompts) text = `${settings.promptPrefix || ""}${text}${settings.promptSuffix || ""}`;
  if (settings.includeAspectRatioInPrompt && item.aspectRatio) {
    // meta.ai has no aspect-ratio control in the chat box; the ratio is passed as a plain instruction.
    text = `${text}\n\nAspect ratio: ${item.aspectRatio}`;
  }
  return text;
}

export function newProjectState(validation, sourceName) {
  return {
    name: validation.projectName,
    sourceName,
    createdAt: new Date().toISOString(),
    items: validation.items.map((it) => ({
      ...it,
      status: STATUS.PENDING,
      attempts: 0,
      error: null,
      outputPath: null,
      format: null,
      width: null,
      height: null,
      previewUrl: null,
      promptSent: null,
      startedAt: null,
      completedAt: null,
    })),
  };
}

export function counts(items) {
  const c = { total: items.length, pending: 0, generating: 0, completed: 0, failed: 0, skipped: 0 };
  for (const it of items) c[it.status] = (c[it.status] || 0) + 1;
  return c;
}

/** Index of the next item to process, in file order; -1 if none. */
export function nextPendingIndex(items) {
  return items.findIndex((it) => it.status === STATUS.PENDING);
}

/** Decide what to do with a failed attempt: retry later or mark failed. Returns the updated item. */
export function applyFailure(item, errorMessage, settings, { retryable = true } = {}) {
  const attempts = item.attempts;
  const canRetry = retryable && attempts <= settings.maxRetries;
  return {
    ...item,
    status: canRetry ? STATUS.PENDING : STATUS.FAILED,
    error: errorMessage,
    completedAt: canRetry ? null : new Date().toISOString(),
    previewUrl: null,
  };
}

/** After a browser restart any "generating" item is unfinished; it goes back to pending so it is retried. */
export function recoverInterrupted(items) {
  return items.map((it) =>
    it.status === STATUS.GENERATING
      ? { ...it, status: STATUS.PENDING, error: "Interrupted by a restart; will be retried." }
      : it,
  );
}

export function resetForRetry(item) {
  return { ...item, status: STATUS.PENDING, attempts: 0, error: null, completedAt: null, previewUrl: null };
}

export function buildManifest(project, settings, items) {
  const c = counts(items);
  return {
    project: project.name,
    source_file: project.sourceName,
    output_folder: `${settings.outputRoot}/${projectFolderOf(project)}`,
    generated_with: "ImageRush (Chrome extension), provider: meta.ai website",
    updated_at: new Date().toISOString(),
    totals: c,
    images: items.map((it) => ({
      id: it.promptId,
      position: it.position,
      filename: it.filename,
      prompt: it.prompt,
      prompt_sent: it.promptSent,
      aspect_ratio: it.aspectRatio,
      status: it.status,
      output_path: it.outputPath,
      format: it.format,
      width: it.width,
      height: it.height,
      attempts: it.attempts,
      started_at: it.startedAt,
      completed_at: it.completedAt,
      error: it.error,
    })),
  };
}

export function buildFailedReport(project, items) {
  const failed = items.filter((it) => it.status === STATUS.FAILED);
  return {
    project: project.name,
    updated_at: new Date().toISOString(),
    count: failed.length,
    failed: failed.map((it) => ({
      id: it.promptId,
      filename: it.filename,
      prompt: it.prompt,
      aspect_ratio: it.aspectRatio,
      attempts: it.attempts,
      error: it.error,
    })),
  };
}

import { projectFolderName } from "./validation.js";
export function projectFolderOf(project) {
  return projectFolderName(project.name);
}
