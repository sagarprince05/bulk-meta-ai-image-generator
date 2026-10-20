// Runs inside the meta.ai tab. It only does what a person would do by hand: type the prompt into
// the chat box, press send, wait for the picture to appear, and read the picture back.
// It never touches logins, CAPTCHAs or rate limits; if those appear it reports them and stops.
(() => {
  if (window.__bulkgenInstalled) return;
  window.__bulkgenInstalled = true;
  // Visible from the page's own world too, so "is the adapter loaded?" can be checked from devtools.
  try { document.documentElement.setAttribute("data-bulkgen-adapter", chrome.runtime.getManifest().version); } catch { /* ignore */ }

  const MIN_IMAGE_SIDE = 256;
  const POLL_MS = 400;
  const STABLE_MS = 2200; // images must stop changing for this long before we accept them

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  // ---------- page discovery ----------

  function findComposer() {
    const candidates = [
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea'),
    ].filter(isVisible).filter((el) => !el.closest("[data-bulkgen]"));
    if (!candidates.length) return null;
    const score = (el) => {
      let s = 0;
      const hint = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-placeholder") || ""}`.toLowerCase();
      if (/ask|message|prompt|imagine|describe|create|type/.test(hint)) s += 5;
      if (el.getAttribute("role") === "textbox") s += 2;
      s += el.getBoundingClientRect().top / 1000; // prefer the lowest box (the chat composer sits at the bottom)
      return s;
    };
    return candidates.sort((a, b) => score(b) - score(a))[0];
  }

  function findSendButton(composer) {
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
    const labelled = buttons.filter((b) => /send|submit|generate/i.test(`${b.getAttribute("aria-label") || ""} ${b.title || ""} ${b.textContent || ""}`.slice(0, 80)));
    if (labelled.length) {
      if (!composer) return labelled[0];
      const c = composer.getBoundingClientRect();
      return labelled.sort((a, b) => dist(a.getBoundingClientRect(), c) - dist(b.getBoundingClientRect(), c))[0];
    }
    return null;
  }

  function dist(a, b) {
    return Math.hypot(a.left + a.width / 2 - (b.left + b.width / 2), a.top + a.height / 2 - (b.top + b.height / 2));
  }

  function loginWallPresent() {
    const text = document.body?.innerText || "";
    const hasLogin = /\b(log in|login|sign in|sign up|continue with facebook|continue with instagram)\b/i.test(text);
    return hasLogin && !findComposer();
  }

  function detectErrorText() {
    const text = (document.body?.innerText || "").slice(-4000);
    const patterns = [
      [/too many requests|rate limit|slow down|try again later|reached your limit|limit for today|daily limit/i, "Meta AI reports a usage limit. Pausing is recommended."],
      [/can't generate|cannot generate|unable to generate|couldn't generate|wasn't able to generate|not able to create/i, "Meta AI declined to generate this prompt."],
      [/something went wrong|an error occurred|please try again later/i, "Meta AI showed an error message."],
    ];
    for (const [re, message] of patterns) if (re.test(text)) return message;
    return null;
  }

  // ---------- image handling ----------

  function candidateImages() {
    return [...document.images].filter((img) => {
      if (!isVisible(img)) return false;
      const rect = img.getBoundingClientRect();
      const big = Math.min(rect.width, rect.height) >= 120 || Math.min(img.naturalWidth, img.naturalHeight) >= MIN_IMAGE_SIDE;
      if (!big) return false;
      const src = img.currentSrc || img.src || "";
      if (!src || /\/(avatar|profile|logo|icon)/i.test(src)) return false;
      if (img.closest("header, nav, [data-bulkgen]")) return false;
      return true;
    });
  }

  function imageKey(img) {
    return img.currentSrc || img.src;
  }

  function snapshotKeys() {
    return new Set(candidateImages().map(imageKey));
  }

  function waitForLoaded(img, timeoutMs = 20000) {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
      setTimeout(done, timeoutMs);
    });
  }

  async function toDataUrl(img, wantFormat) {
    const src = img.currentSrc || img.src;
    let blob;
    try {
      const resp = await fetch(src, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      blob = await resp.blob();
    } catch {
      // Cross-origin fetch blocked: try the already-decoded element (works only if the CDN allows it)
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("canvas"))), "image/png"));
      } catch {
        return null; // caller falls back to downloading the URL directly
      }
    }
    if (!blob.type.startsWith("image/")) return null;
    let ext = blob.type.replace("image/", "").replace("jpeg", "jpg");
    if (wantFormat === "png" && blob.type !== "image/png") {
      try {
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        blob = await canvas.convertToBlob({ type: "image/png" });
        ext = "png";
      } catch {
        // keep the original format rather than fail
      }
    }
    const dataUrl = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.onerror = () => rej(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl, ext };
  }

  // ---------- typing ----------

  async function enterPrompt(composer, text) {
    composer.focus();
    if (composer.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(composer, text);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // Rich-text editors (Lexical/Draft) listen to beforeinput/input; execCommand produces both.
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted || !(composer.innerText || "").trim()) {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    await sleep(120);
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // ---------- main action ----------


  /** Start a fresh conversation without reloading the page: the sidebar "New chat" button or its shortcut. */
  async function newChat() {
    const beforeUrl = location.href;
    const btn = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')].find((el) => isVisible(el) && /^\s*new chat\b/i.test(el.textContent || "") || /new chat/i.test(el.getAttribute("aria-label") || ""));
    if (btn) btn.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "O", code: "KeyO", keyCode: 79, ctrlKey: true, shiftKey: true, bubbles: true }));
    // Ready when the URL left the old conversation (or was already home) and the composer is present and empty.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(150);
      const c = findComposer();
      const text = c ? (c.tagName === "TEXTAREA" ? c.value : c.innerText || "").trim() : "x";
      const urlOk = location.href !== beforeUrl || !/\/prompt\//.test(beforeUrl);
      if (c && !text && urlOk && candidateImages().length === 0) return true;
    }
    return false;
  }

  /** Wait until the chat box exists (after a navigation) instead of sleeping a fixed time. */
  async function waitForComposer(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const c = findComposer();
      if (c) return c;
      if (loginWallPresent()) return null;
      await sleep(150);
    }
    return findComposer();
  }

  async function generate({ prompt, timeoutMs, wantFormat, allVariants }) {
    if (loginWallPresent()) {
      return { ok: false, retryable: false, loginRequired: true, error: "You are not logged in to meta.ai. Log in in this tab, then resume." };
    }
    const composer = await waitForComposer();
    if (!composer) {
      return { ok: false, retryable: true, error: "Could not find the chat box on meta.ai. The page layout may have changed; open the tab and check it loaded." };
    }
    const before = snapshotKeys();
    await enterPrompt(composer, prompt);
    const typed = composer.tagName === "TEXTAREA" ? composer.value : composer.innerText;
    if (!typed || typed.trim().slice(0, 40) !== prompt.trim().slice(0, 40)) {
      return { ok: false, retryable: true, error: "The prompt could not be typed into the chat box." };
    }
    const sendButton = findSendButton(composer);
    if (sendButton) sendButton.click();
    else pressEnter(composer);
    await sleep(700);
    const stillTyped = (composer.tagName === "TEXTAREA" ? composer.value : composer.innerText || "").trim();
    if (stillTyped && stillTyped.slice(0, 40) === prompt.trim().slice(0, 40)) {
      // Button click did not submit; try Enter as a fallback.
      pressEnter(composer);
      await sleep(1500);
    }

    const deadline = Date.now() + timeoutMs;
    let fresh = [];
    let lastChange = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      port?.postMessage({ type: "heartbeat" });
      const current = candidateImages().filter((img) => !before.has(imageKey(img)));
      const keys = current.map(imageKey).join("|");
      if (keys !== fresh.map(imageKey).join("|")) {
        fresh = current;
        lastChange = Date.now();
      }
      if (fresh.length && lastChange && Date.now() - lastChange >= STABLE_MS) {
        const loaded = await Promise.all(fresh.map((img) => waitForLoaded(img).then(() => img.naturalWidth > 0)));
        if (loaded.every(Boolean)) break;
        lastChange = Date.now();
      }
      if (!fresh.length) {
        const err = detectErrorText();
        if (err && Date.now() - (deadline - timeoutMs) > 8000) {
          return { ok: false, retryable: !/declined/.test(err), error: err };
        }
      }
    }
    if (!fresh.length) {
      return { ok: false, retryable: true, error: `No image appeared within ${Math.round(timeoutMs / 1000)}s.` };
    }
    // Largest first; a single image unless the user asked for every variant.
    fresh.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    const chosen = allVariants ? fresh : [fresh[0]];
    const images = [];
    for (const img of chosen) {
      const converted = await toDataUrl(img, wantFormat);
      const url = img.currentSrc || img.src;
      const extFromUrl = (/\.(png|jpe?g|webp|gif)(\?|$)/i.exec(url) || [])[1]?.toLowerCase().replace("jpeg", "jpg");
      images.push({
        url,
        dataUrl: converted?.dataUrl || null,
        ext: converted?.ext || extFromUrl || "jpg",
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    }
    return { ok: true, images };
  }

  function diagnose() {
    const composer = findComposer();
    return {
      ok: true,
      url: location.href,
      loggedIn: !loginWallPresent(),
      composerFound: !!composer,
      composerKind: composer ? composer.tagName.toLowerCase() : null,
      sendButtonFound: !!findSendButton(composer),
      visibleImages: candidateImages().length,
    };
  }

  // ---------- wiring ----------

  let port = null;
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "bulkgen-content" });
      port.onDisconnect.addListener(() => { port = null; });
    } catch {
      port = null;
    }
  }
  connectPort();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === "ping") { sendResponse({ ok: true }); return false; }
    if (msg.type === "diagnose") { sendResponse(diagnose()); return false; }
    if (msg.type === "new_chat") { newChat().then((ok) => sendResponse({ ok })).catch(() => sendResponse({ ok: false })); return true; }
    if (msg.type === "generate") {
      if (!port) connectPort();
      generate(msg).then(sendResponse).catch((exc) => sendResponse({ ok: false, retryable: true, error: exc?.message || String(exc) }));
      return true;
    }
    return false;
  });
})();
