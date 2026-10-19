import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPrompts, detectLayout, suggestFilename, extractAspectRatio, textToPromptFile, stripBullet } from "../extension/lib/parse-prompts.js";
import { validatePromptFile } from "../extension/lib/validation.js";

const numbered = `1\\. Create a beautiful Diwali celebration in a traditional Indian courtyard decorated with glowing clay diyas, photorealistic, 4K quality, no text.

2\\. Generate a breathtaking Diwali night scene featuring a magnificent Indian palace illuminated by thousands of golden lights.

3\\. Create an elegant Diwali Lakshmi Puja setup featuring a beautifully decorated goddess Lakshmi idol, brass diyas.`;

test("numbered list with escaped dots (markdown paste) splits into clean prompts", () => {
  assert.equal(detectLayout(numbered), "numbered");
  const parts = splitPrompts(numbered);
  assert.equal(parts.length, 3);
  assert.ok(parts[0].startsWith("Create a beautiful Diwali"));
  assert.ok(parts[2].endsWith("brass diyas."));
  assert.ok(!parts[1].includes("2\\."));
});

test("one prompt per line and bullet markers", () => {
  const text = "- A red fox in snow\n• A blue whale at sunset\n* A cat on a roof\nA plain line";
  assert.equal(detectLayout(text), "lines");
  assert.deepEqual(splitPrompts(text), ["A red fox in snow", "A blue whale at sunset", "A cat on a roof", "A plain line"]);
});

test("paragraph prompts separated by blank lines keep inner line breaks", () => {
  const text = "First prompt line one,\nline two.\n\nSecond prompt here.\n\n\nThird.";
  assert.equal(detectLayout(text), "paragraphs");
  const parts = splitPrompts(text);
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "First prompt line one,\nline two.");
});

test("numbered item continued on the next line stays one prompt", () => {
  const text = "1. A long prompt that\ncontinues here.\n2. Second.";
  assert.deepEqual(splitPrompts(text), ["A long prompt that\ncontinues here.", "Second."]);
});

test("filename suggestions skip filler words and are unique", () => {
  assert.equal(suggestFilename("Create a beautiful Diwali celebration in a traditional Indian courtyard"), "diwali_celebration_traditional_indian");
  assert.equal(suggestFilename("Generate a breathtaking Diwali night scene featuring a magnificent Indian palace"), "diwali_night_indian_palace");
  assert.equal(suggestFilename("Noah's Ark floating on the floodwaters"), "noahs_ark_floating_floodwaters");
  assert.equal(suggestFilename("!!! ???"), "prompt");
  const file = textToPromptFile("Diwali diyas\nDiwali diyas\nDiwali diyas", { defaultAspectRatio: null });
  assert.deepEqual(file.prompts.map((p) => p.filename), ["diwali_diyas", "diwali_diyas_2", "diwali_diyas_3"]);
});

test("inline aspect ratios are extracted, default applied otherwise", () => {
  assert.deepEqual(extractAspectRatio("A tall poster [9:16]"), { prompt: "A tall poster", aspectRatio: "9:16" });
  assert.deepEqual(extractAspectRatio("Square logo, aspect ratio 1:1, flat"), { prompt: "Square logo, flat", aspectRatio: "1:1" });
  const file = textToPromptFile("A tall poster [9:16]\nA wide banner", { project: " Diwali ", defaultAspectRatio: "16:9" });
  assert.equal(file.project, "Diwali");
  assert.equal(file.prompts[0].aspect_ratio, "9:16");
  assert.equal(file.prompts[1].aspect_ratio, "16:9");
});

test("generated JSON passes the tool's own validator unchanged", () => {
  const file = textToPromptFile(numbered, { project: "Diwali" });
  const r = validatePromptFile(JSON.stringify(file), "pasted.json");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].prompt, splitPrompts(numbered)[0], "prompt text preserved exactly");
});

test("empty or whitespace input yields no prompts; stripBullet leaves plain text alone", () => {
  assert.deepEqual(splitPrompts("   \n\n"), []);
  assert.equal(stripBullet("Hello world"), "Hello world");
  assert.equal(stripBullet("12) Hello"), "Hello");
  assert.equal(stripBullet("3\\. Hello"), "Hello");
});
