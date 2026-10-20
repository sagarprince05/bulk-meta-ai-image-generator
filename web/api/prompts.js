// Vercel serverless function: writes or rewrites image prompts with Claude.
// The API key lives only in the ANTHROPIC_API_KEY environment variable on Vercel.
// It is never sent to the browser, never logged, and never echoed in errors.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_PROMPTS_PER_REQUEST = Number(process.env.MAX_PROMPTS_PER_REQUEST || 50);
const DAILY_LIMIT_PER_IP = Number(process.env.DAILY_LIMIT_PER_IP || 300);
const ACCESS_CODE = process.env.ACCESS_CODE || ""; // optional: require a shared code from the UI
const ALLOWED_ORIGINS = [
  "https://bulk-meta-ai-image-generator-web.vercel.app",
  "chrome-extension://dpbebhhioolcdpffimbegacinlfipeia",
  ...(process.env.EXTRA_ORIGINS ? process.env.EXTRA_ORIGINS.split(",").map((s) => s.trim()) : []),
];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Best-effort per-instance counter (serverless instances are not shared, so this is a soft cap).
const usage = new Map();
function countUsage(ip, n) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}:${ip}`;
  const used = (usage.get(key) || 0) + n;
  usage.set(key, used);
  if (usage.size > 5000) usage.clear();
  return used;
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Access-Code");
  res.setHeader("Access-Control-Max-Age", "600");
}

const SYSTEM = `You write prompts for an AI image generator (Meta AI). The user describes what they want; you return the requested number of distinct, self-contained image prompts.

Rules:
- Each prompt must fully describe one image: subject, setting, composition, lighting, mood, style and quality words.
- 25-60 words each. Plain English, no numbering, no quotes, no markdown, no "Prompt:" prefixes.
- Vary subjects and compositions across prompts; do not repeat the same scene.
- Apply the user's style notes to every prompt. If the user names a style, keep it; otherwise default to photorealistic, cinematic lighting.
- Never include text overlays, captions, logos or watermarks in the image unless the user asks; you may add "no text, no watermark".
- Keep content safe for a general audience and avoid real people's likenesses.

Output format: a JSON array of strings only, nothing before or after it.`;

function extractJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("Claude did not return a JSON array.");
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("Claude did not return a JSON array.");
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "AI prompt writing is not configured on this site.", configured: false });
  if (ACCESS_CODE && req.headers["x-access-code"] !== ACCESS_CODE) return res.status(401).json({ error: "Access code required." });

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body || {};
  const task = body.task === "rewrite" ? "rewrite" : "write";
  const brief = String(body.brief || "").slice(0, 4000).trim();
  const style = String(body.style || "").slice(0, 500).trim();
  const aspectRatio = /^\d{1,2}:\d{1,2}$/.test(String(body.aspectRatio || "")) ? body.aspectRatio : null;
  const count = Math.max(1, Math.min(MAX_PROMPTS_PER_REQUEST, Number(body.count) || 10));
  const existing = Array.isArray(body.existing) ? body.existing.slice(-40).map((s) => String(s).slice(0, 600)) : [];
  if (!brief) return res.status(400).json({ error: "Describe what you want first." });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  const want = task === "rewrite" ? 1 : count;
  if (countUsage(ip, want) > DAILY_LIMIT_PER_IP) return res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT_PER_IP} AI prompts reached. Try again tomorrow or add prompts manually.` });

  let userText;
  if (task === "rewrite") {
    userText = `Rewrite this single image prompt to be clearer and more vivid while keeping its subject and intent.${style ? ` Style notes: ${style}.` : ""}${aspectRatio ? ` Target aspect ratio ${aspectRatio}.` : ""}\n\nPrompt:\n${brief}\n\nReturn a JSON array with exactly one string.`;
  } else {
    userText = `Write ${count} image prompts.${style ? ` Style notes: ${style}.` : ""}${aspectRatio ? ` Target aspect ratio ${aspectRatio} (compose for it, but do not write the ratio in the prompt).` : ""}\n\nWhat the user wants:\n${brief}${existing.length ? `\n\nAlready in the list (do not repeat these scenes):\n${existing.map((p) => `- ${p}`).join("\n")}` : ""}\n\nReturn a JSON array of exactly ${count} strings.`;
  }

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The AI declined to write prompts for that request. Please rephrase it." });
    }
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const prompts = extractJsonArray(text).slice(0, want);
    if (!prompts.length) throw new Error("No prompts were returned.");
    return res.status(200).json({ prompts, model: response.model, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } });
  } catch (exc) {
    if (exc instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "AI prompt writing is misconfigured on this site (invalid key)." });
    if (exc instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "The AI service is busy. Try again in a minute." });
    if (exc instanceof Anthropic.APIError) return res.status(502).json({ error: `AI service error (${exc.status}).` });
    return res.status(500).json({ error: exc.message === "Claude did not return a JSON array." ? "The AI reply could not be read. Try again." : "Unexpected error while writing prompts." });
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
