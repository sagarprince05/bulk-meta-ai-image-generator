// Injected into the built-in Meta AI window. Does only what a person would do by hand:
// type the prompt, press send, wait for the picture, report its URL. No login or CAPTCHA handling.
(() => {
  if (window.__imagerush) return;
  const MIN_IMAGE_SIDE = 256;
  const POLL_MS = 400;
  const STABLE_MS = 2200;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const dist = (a, b) => Math.hypot(a.left + a.width / 2 - (b.left + b.width / 2), a.top + a.height / 2 - (b.top + b.height / 2));

  // When the panel is hidden the page has no layout, so fall back to "exists in the DOM".
  const present = (el) => (document.visibilityState === "hidden" ? !!el && el.isConnected && !el.closest("[hidden]") : isVisible(el));
  function findComposer() {
    const candidates = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea')].filter(present);
    if (!candidates.length) return null;
    const score = (el) => {
      let s = 0;
      const hint = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-placeholder") || ""}`.toLowerCase();
      if (/ask|message|prompt|imagine|describe|create|type/.test(hint)) s += 5;
      if (el.getAttribute("role") === "textbox") s += 2;
      s += el.getBoundingClientRect().top / 1000;
      return s;
    };
    return candidates.sort((a, b) => score(b) - score(a))[0];
  }
  function findSendButton(composer) {
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
    const labelled = buttons.filter((b) => /send|submit|generate/i.test(`${b.getAttribute("aria-label") || ""} ${b.title || ""} ${b.textContent || ""}`.slice(0, 80)));
    if (!labelled.length) return null;
    if (!composer) return labelled[0];
    const c = composer.getBoundingClientRect();
    return labelled.sort((a, b) => dist(a.getBoundingClientRect(), c) - dist(b.getBoundingClientRect(), c))[0];
  }
  function loginWallPresent() {
    const text = document.body?.innerText || "";
    return /\b(log in|login|sign in|sign up|continue with facebook|continue with instagram)\b/i.test(text) && !findComposer();
  }
  function detectErrorText() {
    const text = (document.body?.innerText || "").slice(-4000);
    const patterns = [
      [/too many requests|rate limit|slow down|reached your limit|limit for today|daily limit/i, "Meta AI reports a usage limit. Pausing is recommended."],
      [/can't generate|cannot generate|unable to generate|couldn't generate|wasn't able to generate|not able to create/i, "Meta AI declined to generate this prompt."],
      [/something went wrong|an error occurred|please try again later/i, "Meta AI showed an error message."],
    ];
    for (const [re, message] of patterns) if (re.test(text)) return message;
    return null;
  }
  function candidateImages() {
    return [...document.images].filter((img) => {
      if (!isVisible(img)) return false;
      const rect = img.getBoundingClientRect();
      const big = Math.min(rect.width, rect.height) >= 120 || Math.min(img.naturalWidth, img.naturalHeight) >= MIN_IMAGE_SIDE;
      if (!big) return false;
      const src = img.currentSrc || img.src || "";
      if (!src || /\/(avatar|profile|logo|icon)/i.test(src) || src.startsWith("data:")) return false;
      if (img.closest("header, nav")) return false;
      return true;
    });
  }
  const imageKey = (img) => img.currentSrc || img.src;
  function waitForLoaded(img, timeoutMs = 20000) {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => { img.addEventListener("load", resolve, { once: true }); img.addEventListener("error", resolve, { once: true }); setTimeout(resolve, timeoutMs); });
  }
  async function enterPrompt(composer, text) {
    composer.focus();
    if (composer.tagName === "TEXTAREA") {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(composer, text);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted || !(composer.innerText || "").trim()) {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    await sleep(300);
  }
  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }


  /** Start a fresh conversation without reloading the page: the sidebar "New chat" button or its shortcut. */
  async function newChat() {
    const beforeUrl = location.href;
    const btn = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')].find((el) => isVisible(el) && (/^\s*new chat/i.test(el.textContent || "") || /new chat/i.test(el.getAttribute("aria-label") || "")));
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

  async function generate({ prompt, timeoutMs, allVariants }) {
    if (loginWallPresent()) return { ok: false, retryable: false, loginRequired: true, error: "You are not logged in to Meta AI. Log in in the Meta AI window, then press Resume." };
    const composer = await waitForComposer();
    if (!composer) return { ok: false, retryable: true, error: "Could not find the chat box on meta.ai. Open the Meta AI window and check that the page loaded." };
    const before = new Set(candidateImages().map(imageKey));
    await enterPrompt(composer, prompt);
    const typed = composer.tagName === "TEXTAREA" ? composer.value : composer.innerText;
    if (!typed || typed.trim().slice(0, 40) !== prompt.trim().slice(0, 40)) return { ok: false, retryable: true, error: "The prompt could not be typed into the chat box." };
    const sendButton = findSendButton(composer);
    if (sendButton) sendButton.click(); else pressEnter(composer);
    await sleep(700);
    const still = (composer.tagName === "TEXTAREA" ? composer.value : composer.innerText || "").trim();
    if (still && still.slice(0, 40) === prompt.trim().slice(0, 40)) { pressEnter(composer); await sleep(1500); }

    const deadline = Date.now() + timeoutMs;
    let fresh = [];
    let lastChange = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const current = candidateImages().filter((img) => !before.has(imageKey(img)));
      const keys = current.map(imageKey).join("|");
      if (keys !== fresh.map(imageKey).join("|")) { fresh = current; lastChange = Date.now(); }
      if (fresh.length && lastChange && Date.now() - lastChange >= STABLE_MS) {
        const loaded = await Promise.all(fresh.map((img) => waitForLoaded(img).then(() => img.naturalWidth > 0)));
        if (loaded.every(Boolean)) break;
        lastChange = Date.now();
      }
      if (!fresh.length) {
        const err = detectErrorText();
        if (err && Date.now() - (deadline - timeoutMs) > 8000) return { ok: false, retryable: !/declined/.test(err), error: err };
      }
    }
    if (!fresh.length) return { ok: false, retryable: true, error: `No image appeared within ${Math.round(timeoutMs / 1000)}s.` };
    fresh.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    const chosen = allVariants ? fresh : [fresh[0]];
    return { ok: true, images: chosen.map((img) => ({ url: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight })) };
  }

  function diagnose() {
    const composer = findComposer();
    return { ok: true, url: location.href, loggedIn: !loginWallPresent(), composerFound: !!composer, composerKind: composer ? composer.tagName.toLowerCase() : null, sendButtonFound: !!findSendButton(composer), visibleImages: candidateImages().length };
  }

  // Status watcher: reports login/ready changes the moment the page changes (meta.ai is a single-page app).
  let lastSig = "";
  function pushStatus(force) {
    const c = findComposer();
    const st = { loggedIn: !loginWallPresent(), ready: !!c, url: location.href };
    const sig = JSON.stringify(st);
    if (force || sig !== lastSig) { lastSig = sig; console.log("__imagerush_status:" + sig); }
  }
  const mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(() => pushStatus(false), 150); });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "aria-label"] });
  setInterval(() => pushStatus(false), 1000);
  document.addEventListener("visibilitychange", () => pushStatus(true));
  window.addEventListener("focus", () => pushStatus(true));
  setTimeout(() => pushStatus(true), 0);

  window.__imagerush = { generate, diagnose, newChat, pushStatus };
})();
