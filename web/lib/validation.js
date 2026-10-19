// Pure functions: parse and validate the uploaded prompt JSON. No browser APIs, so Node tests can run it.

export const MAX_PROMPTS = 10000;
const ASPECT_RE = /^\s*(\d{1,5})\s*:\s*(\d{1,5})\s*$/;
const KNOWN_PROMPT_FIELDS = new Set(["id", "filename", "prompt", "aspect_ratio"]);
const KNOWN_ROOT_FIELDS = new Set(["project", "prompts"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Make text safe as one path component: no separators, no control chars, no reserved names. */
export function sanitizeComponent(name, maxLen = 120) {
  let cleaned = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/^[. ]+|[. ]+$/g, "");
  cleaned = cleaned.replace(/\s+/g, " ").slice(0, maxLen).replace(/[. ]+$/g, "");
  if (WINDOWS_RESERVED.has(cleaned.toUpperCase())) cleaned = `${cleaned}_`;
  return cleaned;
}

export function stripImageExtension(name) {
  const match = /^(.*)(\.[A-Za-z0-9]+)$/.exec(name);
  if (match && IMAGE_EXTENSIONS.has(match[2].toLowerCase()) && match[1]) return match[1];
  return name;
}

export function projectFolderName(projectName) {
  return sanitizeComponent(projectName).replace(/ /g, "_") || "Untitled_Project";
}

export function parseAspectRatio(value) {
  const match = ASPECT_RE.exec(value);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (w <= 0 || h <= 0) return null;
  return [w, h];
}

/**
 * @param {string} text raw file contents
 * @param {string} sourceName file name, used as a fallback project name
 * @returns {{ok:boolean, projectName:string, items:Array, errors:string[], warnings:string[]}}
 */
export function validatePromptFile(text, sourceName = "") {
  const errors = [];
  const warnings = [];
  const fallbackName = (sourceName.replace(/\.[^.]*$/, "") || "Untitled Project").trim() || "Untitled Project";
  const fail = (projectName, errs) => ({ ok: false, projectName, items: [], errors: errs, warnings });

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return fail(fallbackName, ["The file is empty."]);

  let data;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    return fail(fallbackName, [`The file is not valid JSON: ${exc.message}.`]);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    const kind = Array.isArray(data) ? "a list" : data === null ? "null" : typeof data;
    return fail(fallbackName, [
      `The top level must be an object like {"project": "...", "prompts": [...]}, but the file contains ${kind}.`,
    ]);
  }

  let projectName = fallbackName;
  if (!("project" in data)) {
    warnings.push(`No "project" name found; using "${fallbackName}".`);
  } else if (typeof data.project !== "string") {
    errors.push('"project" must be text.');
  } else if (!data.project.trim()) {
    warnings.push(`"project" is empty; using "${fallbackName}".`);
  } else {
    projectName = data.project.trim();
    if (!sanitizeComponent(projectName)) errors.push(`"project" ("${projectName}") cannot be turned into a folder name.`);
  }

  const unknownRoot = Object.keys(data).filter((k) => !KNOWN_ROOT_FIELDS.has(k)).sort();
  if (unknownRoot.length) warnings.push(`Ignoring unknown top-level field(s): ${unknownRoot.join(", ")}.`);

  if (!("prompts" in data)) {
    errors.push('Missing required field "prompts" (a list of prompt objects).');
    return fail(projectName, errors);
  }
  const prompts = data.prompts;
  if (!Array.isArray(prompts)) {
    errors.push('"prompts" must be a list.');
    return fail(projectName, errors);
  }
  if (!prompts.length) {
    errors.push('"prompts" is empty. Add at least one prompt.');
    return fail(projectName, errors);
  }
  if (prompts.length > MAX_PROMPTS) {
    errors.push(`Too many prompts (${prompts.length}). The limit is ${MAX_PROMPTS} per file.`);
    return fail(projectName, errors);
  }

  const items = [];
  const seenIds = new Map();
  const seenNames = new Map();
  const unknownFields = new Set();
  let missingIds = 0;

  prompts.forEach((raw, index) => {
    const pos = index + 1;
    let where = `Prompt #${pos}`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${where}: must be an object with "filename" and "prompt".`);
      return;
    }
    Object.keys(raw).forEach((k) => {
      if (!KNOWN_PROMPT_FIELDS.has(k)) unknownFields.add(k);
    });
    let itemOk = true;

    let pid;
    if ("id" in raw) {
      pid = raw.id;
      const validId = (typeof pid === "number" && Number.isFinite(pid)) || (typeof pid === "string" && pid.trim());
      if (!validId) {
        errors.push(`${where}: "id" must be a number or non-empty text.`);
        itemOk = false;
        pid = pos;
      } else {
        where = `Prompt #${pos} (id ${pid})`;
        const key = String(pid).trim();
        if (seenIds.has(key)) {
          errors.push(`${where}: duplicate id "${pid}" (also used by prompt #${seenIds.get(key)}).`);
          itemOk = false;
        } else {
          seenIds.set(key, pos);
        }
      }
    } else {
      pid = pos;
      missingIds += 1;
    }

    const prompt = raw.prompt;
    if (!("prompt" in raw)) {
      errors.push(`${where}: missing required field "prompt".`);
      itemOk = false;
    } else if (typeof prompt !== "string") {
      errors.push(`${where}: "prompt" must be text.`);
      itemOk = false;
    } else if (!prompt.trim()) {
      errors.push(`${where}: "prompt" is empty.`);
      itemOk = false;
    }

    const originalFilename = raw.filename;
    let safeName = "";
    if (!("filename" in raw)) {
      errors.push(`${where}: missing required field "filename".`);
      itemOk = false;
    } else if (typeof originalFilename !== "string" || !originalFilename.trim()) {
      errors.push(`${where}: "filename" must be non-empty text.`);
      itemOk = false;
    } else {
      safeName = sanitizeComponent(stripImageExtension(originalFilename.trim()));
      if (!safeName) {
        errors.push(`${where}: filename "${originalFilename}" has no usable characters.`);
        itemOk = false;
      } else if (safeName !== originalFilename.trim()) {
        warnings.push(`${where}: filename "${originalFilename}" will be saved as "${safeName}".`);
      }
    }

    let aspect = null;
    if (raw.aspect_ratio !== undefined && raw.aspect_ratio !== null) {
      const ar = raw.aspect_ratio;
      const parsed = typeof ar === "string" ? parseAspectRatio(ar) : null;
      if (!parsed) {
        errors.push(`${where}: aspect_ratio "${ar}" must look like "16:9" (two positive whole numbers).`);
        itemOk = false;
      } else {
        aspect = `${parsed[0]}:${parsed[1]}`;
      }
    }

    if (itemOk) {
      const lower = safeName.toLowerCase();
      if (!seenNames.has(lower)) seenNames.set(lower, []);
      seenNames.get(lower).push(pos);
      items.push({
        position: pos,
        promptId: pid,
        filename: safeName,
        originalFilename,
        prompt, // exact text, never trimmed or altered
        aspectRatio: aspect,
      });
    }
  });

  if (missingIds) warnings.push(`${missingIds} prompt(s) have no "id"; their position in the file is used instead.`);
  if (unknownFields.size) warnings.push(`Ignoring unknown prompt field(s): ${[...unknownFields].sort().join(", ")}.`);
  for (const [name, positions] of seenNames) {
    if (positions.length > 1) {
      warnings.push(
        `Filename "${name}" is used by prompts ${positions.map((p) => `#${p}`).join(", ")}. ` +
          `Later images get a number suffix (for example ${name} (1).png).`,
      );
    }
  }

  return { ok: errors.length === 0, projectName, items: errors.length ? [] : items, errors, warnings };
}
