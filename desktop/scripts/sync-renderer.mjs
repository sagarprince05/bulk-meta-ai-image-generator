// Copies the website UI into desktop/renderer and overlays the desktop-specific modules.
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "web");
const out = join(here, "..", "renderer");
const overrides = join(here, "..", "renderer-overrides");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of ["index.html", "app.css", "app.js", "lib", "icons", "samples"]) {
  const src = join(web, name);
  if (existsSync(src)) cpSync(src, join(out, name), { recursive: true });
}
cpSync(overrides, out, { recursive: true });
console.log("renderer synced from web/ with desktop overrides");
