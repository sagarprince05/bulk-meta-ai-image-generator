import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePromptFile, sanitizeComponent, projectFolderName, stripImageExtension } from "../extension/lib/validation.js";

const sample = readFileSync(new URL("../samples/test_prompts.json", import.meta.url), "utf-8");

test("sample file with three prompts validates cleanly", () => {
  const r = validatePromptFile(sample, "test_prompts.json");
  assert.equal(r.ok, true);
  assert.equal(r.projectName, "Bible Images");
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.filename), ["creation_of_world", "noahs_ark", "moses_red_sea"]);
  assert.equal(r.items[0].aspectRatio, "16:9");
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("prompt text is preserved exactly, including whitespace", () => {
  const text = JSON.stringify({ project: "P", prompts: [{ id: 1, filename: "a", prompt: "  keep   this\n exactly  " }] });
  const r = validatePromptFile(text);
  assert.equal(r.items[0].prompt, "  keep   this\n exactly  ");
});

test("invalid JSON reports line and column", () => {
  const r = validatePromptFile('{"project": "x", "prompts": [}', "bad.json");
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /not valid JSON/);
});

test("empty file, wrong top level, missing prompts", () => {
  assert.equal(validatePromptFile("   ").errors[0], "The file is empty.");
  assert.match(validatePromptFile("[1,2]").errors[0], /top level must be an object/);
  assert.match(validatePromptFile('{"project":"x"}').errors[0], /Missing required field "prompts"/);
  assert.match(validatePromptFile('{"project":"x","prompts":[]}').errors[0], /empty/);
  assert.match(validatePromptFile('{"project":"x","prompts":"no"}').errors[0], /must be a list/);
});

test("missing or wrong fields are reported per prompt", () => {
  const text = JSON.stringify({
    project: "P",
    prompts: [{ id: 1, filename: "a" }, { id: 2, prompt: "p" }, { id: 3, filename: "", prompt: "" }, "nope", { id: 1, filename: "dup", prompt: "x" }],
  });
  const r = validatePromptFile(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Prompt #1 (id 1): missing required field "prompt"')));
  assert.ok(r.errors.some((e) => e.includes('Prompt #2 (id 2): missing required field "filename"')));
  assert.ok(r.errors.some((e) => e.includes('"filename" must be non-empty text')));
  assert.ok(r.errors.some((e) => e.includes('"prompt" is empty')));
  assert.ok(r.errors.some((e) => e.includes("Prompt #4: must be an object")));
  assert.ok(r.errors.some((e) => e.includes('duplicate id "1"')));
  assert.equal(r.items.length, 0);
});

test("aspect ratio validation", () => {
  const mk = (ar) => validatePromptFile(JSON.stringify({ project: "P", prompts: [{ filename: "a", prompt: "p", aspect_ratio: ar }] }));
  assert.equal(mk("16:9").items[0].aspectRatio, "16:9");
  assert.equal(mk(" 4 : 3 ").items[0].aspectRatio, "4:3");
  assert.equal(mk("wide").ok, false);
  assert.equal(mk("0:1").ok, false);
  assert.equal(mk(16).ok, false);
  assert.equal(mk(null).items[0].aspectRatio, null);
});

test("warnings for missing project, missing ids, unknown fields, duplicate filenames", () => {
  const r = validatePromptFile(JSON.stringify({ extra: 1, prompts: [{ filename: "x", prompt: "a", foo: 1 }, { filename: "X", prompt: "b" }] }), "my_file.json");
  assert.equal(r.ok, true);
  assert.equal(r.projectName, "my_file");
  assert.ok(r.warnings.some((w) => w.includes('No "project" name')));
  assert.ok(r.warnings.some((w) => w.includes("have no \"id\"")));
  assert.ok(r.warnings.some((w) => w.includes("unknown prompt field(s): foo")));
  assert.ok(r.warnings.some((w) => w.includes("unknown top-level field(s): extra")));
  assert.ok(r.warnings.some((w) => w.includes('Filename "x" is used by prompts #1, #2')));
});

test("filenames are made safe and extensions stripped", () => {
  assert.equal(sanitizeComponent('a<b>:"c/d\\e|f?g*h'), "a_b___c_d_e_f_g_h");
  assert.equal(sanitizeComponent("  ..dots..  "), "dots");
  assert.equal(sanitizeComponent("CON"), "CON_");
  assert.equal(stripImageExtension("photo.PNG"), "photo");
  assert.equal(stripImageExtension("v1.2"), "v1.2");
  assert.equal(projectFolderName("Bible Images"), "Bible_Images");
  const r = validatePromptFile(JSON.stringify({ project: "P", prompts: [{ filename: "my pic.png", prompt: "p" }] }));
  assert.equal(r.items[0].filename, "my pic");
  assert.ok(r.warnings[0].includes('will be saved as "my pic"'));
});

test("BOM and very large counts", () => {
  assert.equal(validatePromptFile('﻿{"project":"P","prompts":[{"filename":"a","prompt":"b"}]}').ok, true);
  const many = { project: "P", prompts: Array.from({ length: 10001 }, (_, i) => ({ filename: `f${i}`, prompt: "p" })) };
  assert.match(validatePromptFile(JSON.stringify(many)).errors[0], /Too many prompts/);
});
