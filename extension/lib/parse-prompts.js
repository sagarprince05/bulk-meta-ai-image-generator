// Turns plain English prompt text (one per line, numbered list, or blank-line separated paragraphs)
// into the JSON structure the tool uses. Pure functions, no browser APIs.
import { sanitizeComponent } from "./validation.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "and", "or", "by", "from", "as", "is", "are",
  "create", "generate", "design", "make", "draw", "render", "produce", "show", "image", "images", "picture",
  "photo", "photograph", "illustration", "scene", "shot", "featuring", "that", "this", "into", "over", "under",
  "beautiful", "stunning", "breathtaking", "magnificent", "spectacular", "elegant", "enchanting", "magical",
  "cinematic", "realistic", "photorealistic", "detailed", "ultra", "highly", "very", "its", "their", "his", "her",
]);
const BULLET_RE = /^\s*(?:\(?\d{1,4}\\?[.):\]]|\\?[-*•–—]|#{1,3})\s+/;
const NUMBER_ONLY_RE = /^\s*\(?\d{1,4}\\?[.):\]]?\s*$/;
const ASPECT_INLINE_RE = /(?:\[\s*(\d{1,2})\s*:\s*(\d{1,2})\s*\]|\baspect\s*ratio\s*[:=]?\s*(\d{1,2})\s*:\s*(\d{1,2})\b|\((\d{1,2})\s*:\s*(\d{1,2})\)\s*$)/i;

/** Remove list markers like "1.", "1\.", "2)", "-", "•" from the start of a line. */
export function stripBullet(line) {
  return line.replace(BULLET_RE, "").replace(/^\s*\\\./, "").trim();
}

/** Detect which layout the text uses: "numbered", "paragraphs" or "lines". */
export function detectLayout(text) {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim());
  if (!nonEmpty.length) return "lines";
  const numbered = nonEmpty.filter((l) => /^\s*\(?\d{1,4}\\?[.):\]]\s+/.test(l)).length;
  if (numbered >= 2 && numbered >= nonEmpty.length * 0.5) return "numbered";
  const blocks = text.split(/\r?\n\s*\r?\n/).filter((b) => b.trim());
  if (blocks.length >= 2 && blocks.some((b) => b.split(/\r?\n/).filter((l) => l.trim()).length > 1)) return "paragraphs";
  return "lines";
}

/** Split text into raw prompt strings, preserving each prompt's own wording. */
export function splitPrompts(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const layout = detectLayout(text);
  const lines = text.split(/\r?\n/);
  const out = [];
  if (layout === "numbered") {
    let current = null;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (/^\s*\(?\d{1,4}\\?[.):\]]\s+/.test(line)) {
        if (current) out.push(current);
        current = stripBullet(line);
      } else if (NUMBER_ONLY_RE.test(line)) {
        if (current) out.push(current);
        current = "";
      } else if (line.trim()) {
        current = current ? `${current}\n${line.trim()}` : line.trim();
      }
      // blank lines inside a numbered item are ignored
    }
    if (current) out.push(current);
  } else if (layout === "paragraphs") {
    for (const block of text.split(/\r?\n\s*\r?\n/)) {
      const cleaned = block.split(/\r?\n/).map((l) => stripBullet(l)).filter(Boolean).join("\n");
      if (cleaned) out.push(cleaned);
    }
  } else {
    for (const line of lines) {
      const cleaned = stripBullet(line);
      if (cleaned) out.push(cleaned);
    }
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Pull an inline aspect ratio like "[9:16]" or "aspect ratio 1:1" out of a prompt. Returns {prompt, aspectRatio}. */
export function extractAspectRatio(prompt) {
  const m = ASPECT_INLINE_RE.exec(prompt);
  if (!m) return { prompt, aspectRatio: null };
  const w = m[1] || m[3] || m[5];
  const h = m[2] || m[4] || m[6];
  const cleaned = prompt
    .replace(m[0], "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/^[,;\s]+|[,;\s]+$/g, "")
    .trim();
  return { prompt: cleaned, aspectRatio: `${Number(w)}:${Number(h)}` };
}

/** Make a short, readable file name from the prompt's first meaningful words. */
export function suggestFilename(prompt, maxWords = 4) {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/'s\b/g, "s")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w) && w.length > 1);
  const picked = words.slice(0, maxWords);
  const name = sanitizeComponent(picked.join("_")).replace(/\s+/g, "_").slice(0, 60).replace(/_+$/g, "");
  return name || "prompt";
}

function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return count === 0 ? n : `${n}_${count + 1}`;
  });
}

/**
 * Build the tool's JSON object from plain text.
 * @param {string} text
 * @param {{project?: string, defaultAspectRatio?: string|null}} options
 */
export function textToPromptFile(text, { project = "Untitled Project", defaultAspectRatio = "16:9" } = {}) {
  const raw = splitPrompts(text);
  const parsed = raw.map((p) => extractAspectRatio(p));
  const names = uniqueNames(parsed.map((p) => suggestFilename(p.prompt)));
  const prompts = parsed.map((p, i) => {
    const item = { id: i + 1, filename: names[i], prompt: p.prompt };
    const ar = p.aspectRatio || defaultAspectRatio;
    if (ar) item.aspect_ratio = ar;
    return item;
  });
  return { project: project.trim() || "Untitled Project", prompts };
}
