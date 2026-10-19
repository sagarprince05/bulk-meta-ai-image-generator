// Runs on the hosted website only. Relays window.postMessage requests from the page to the
// extension's background worker and posts the replies back. Only the request types the
// background exposes to websites are forwarded.
(() => {
  if (window.__bulkgenSiteBridge) return;
  window.__bulkgenSiteBridge = true;
  const ALLOWED = new Set(["ping", "diagnose", "generate", "save"]);

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.__bulkgen !== "request") return;
    const { id, msg } = event.data;
    if (!msg || !ALLOWED.has(msg.type)) {
      window.postMessage({ __bulkgen: "response", id, reply: { ok: false, error: `Unknown request '${msg?.type}'` } }, window.location.origin);
      return;
    }
    let settled = false;
    const respond = (reply) => {
      if (settled) return;
      settled = true;
      window.postMessage({ __bulkgen: "response", id, reply }, window.location.origin);
    };
    try {
      chrome.runtime.sendMessage({ ...msg, __fromSite: true }, (reply) => {
        if (chrome.runtime.lastError) respond({ ok: false, error: `Extension not reachable: ${chrome.runtime.lastError.message}` });
        else respond(reply || { ok: false, error: "Empty reply from the extension." });
      });
    } catch (exc) {
      respond({ ok: false, error: `Extension not reachable: ${exc.message}` });
    }
  });

  document.documentElement.setAttribute("data-bulkgen-bridge", chrome.runtime.getManifest().version);
  window.postMessage({ __bulkgen: "ready", version: chrome.runtime.getManifest().version }, window.location.origin);
})();
