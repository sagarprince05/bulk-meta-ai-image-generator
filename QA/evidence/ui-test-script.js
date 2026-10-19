// Dashboard UI test script, run inside the demo page: await (await import('/ui-test.js')).default()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const refresh = async () => { chrome.runtime.sendMessage({ type: "get_state" }, () => {}); await sleep(120); };

function drop(name, text) {
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: name.endsWith(".json") ? "application/json" : "text/plain" }));
  $("dropzone").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
}

export default async function run() {
  const R = {};
  window.confirm = () => true;
  window.alert = (m) => { R._lastAlert = m; };

  $("dropzone").dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  R["UI-01 dragover highlight"] = $("dropzone").classList.contains("drag");

  drop("x.txt", "hello"); await sleep(100);
  R["VAL-10 txt rejected"] = $("validation").textContent.includes("not a .json file");

  drop("bad.json", '{"prompts":[}'); await sleep(100);
  R["VAL-02 bad json message + no preview"] = $("validation").textContent.includes("not valid JSON") && $("preview").classList.contains("hidden");

  drop("warn.json", JSON.stringify({ prompts: [{ filename: "a b.png", prompt: "x", foo: 1 }, { filename: "a b", prompt: "y" }] })); await sleep(100);
  const vt = $("validation").textContent;
  R["VAL-09 warnings listed"] = $("validation").classList.contains("warn") && vt.includes("unknown prompt field") && vt.includes("will be saved as") && vt.includes("is used by prompts");
  $("btn-cancel-preview").click();
  R["UI-03 cancel hides preview"] = $("preview").classList.contains("hidden");

  const xss = "<img src=x onerror=window.__xss=1> <script>window.__xss=2</script> Noah";
  const good = JSON.stringify({ project: "Bible Images", prompts: [
    { id: 1, filename: "creation_of_world", prompt: "Create a cinematic image one", aspect_ratio: "16:9" },
    { id: 2, filename: "noahs_ark", prompt: xss, aspect_ratio: "16:9" },
    { id: 3, filename: "moses_red_sea", prompt: "Moses prompt", aspect_ratio: "16:9" }] });
  drop("test_prompts.json", good); await sleep(100);
  R["VAL-01 three prompts previewed"] = $("preview-list").children.length === 3 && $("validation").textContent.includes("3 prompt(s) found");
  $("btn-confirm-load").click(); await sleep(150);
  R["UI-02 project loaded"] = $("stat-total").textContent === "3" && $("stat-pending").textContent === "3" && $("run-badge").textContent === "Idle";
  R["UI-05 idle buttons"] = !$("btn-start").disabled && $("btn-pause").disabled && $("btn-resume").disabled && $("btn-stop").disabled && $("btn-retry-failed").disabled;
  R["UI-11 XSS rendered as text"] = window.__xss === undefined && $("queue-body").textContent.includes("<img src=x") && !$("queue-body").querySelector("img[src='x']");
  R["UI-06 columns"] = [...document.querySelectorAll("#queue thead th")].map((t) => t.textContent).join("|");
  const pc = document.querySelector(".prompt-preview"); pc.click();
  R["UI-07 prompt expands"] = pc.classList.contains("open"); pc.click();

  window.__demoFailNext = true;
  $("btn-start").click(); await sleep(150);
  R["UI-05 running buttons"] = !$("btn-pause").disabled && $("btn-start").disabled && $("run-badge").textContent === "Running";
  R["current panel shows Image 1 of 3"] = !$("current").classList.contains("hidden") && $("current-label").textContent.includes("Image 1 of 3");
  $("btn-pause").click(); await sleep(100);
  R["pause -> Pausing badge"] = $("run-badge").textContent;
  await sleep(600); await refresh();
  R["UI-05 paused buttons"] = $("run-badge").textContent === "Paused" && !$("btn-resume").disabled && !$("btn-stop").disabled;
  R["failed row has error text + Retry button"] = $("queue-body").textContent.includes("No image appeared") && !!$("queue-body").querySelector("button[data-act='retry_item']");
  $("filter-failed").checked = true; $("filter-failed").dispatchEvent(new Event("change"));
  R["UI-08 failed filter"] = $("queue-body").querySelectorAll("tr").length === 1 && $("queue-body").textContent.includes("creation_of_world");
  $("filter-failed").checked = false; $("filter-failed").dispatchEvent(new Event("change"));
  R["Retry Failed enabled"] = !$("btn-retry-failed").disabled;
  $("btn-retry-failed").click(); await sleep(1800); await refresh();
  R["UI-10 summary dialog"] = $("summary-dialog").open && $("summary-body").textContent.includes("Completed") && $("stat-completed").textContent === "3";
  $("btn-summary-close").click();
  R["UI-05 finished buttons"] = $("run-badge").textContent === "Finished" && $("btn-start").disabled && !$("btn-export").disabled;
  R["thumbnails shown"] = $("queue-body").querySelectorAll("img.thumb").length === 3;
  R["progress 100%"] = $("progress-bar").style.width === "100%" && $("progress-text").textContent.includes("3 of 3");

  $("btn-settings").click();
  const f = $("settings-form");
  R["UI-09 dialog shows defaults"] = $("settings-dialog").open && f.elements.delaySeconds.value === "8" && f.elements.outputRoot.value === "Generated_Images";
  f.elements.delaySeconds.value = "12"; f.elements.outputRoot.value = "My Images"; f.requestSubmit(); await sleep(100);
  R["UI-09 settings saved"] = window.__demoState.settings.delaySeconds === 12 && window.__demoState.settings.outputRoot === "My Images" && !$("settings-dialog").open;
  $("btn-settings").click(); f.elements.outputRoot.value = "../escape"; f.requestSubmit(); await sleep(100);
  R["SEC-03 ../ rejected"] = window.__demoState.settings.outputRoot === "My Images" && $("toast").textContent.includes("not allowed");
  f.elements.outputRoot.value = "C:\\x"; f.requestSubmit(); await sleep(100);
  R["SEC-03 drive path rejected"] = window.__demoState.settings.outputRoot === "My Images";
  $("btn-settings-cancel").click();

  $("btn-test").click(); await sleep(150);
  R["SMK-05 test connection alert"] = (R._lastAlert || "").includes("Logged in: yes");
  drop("test_prompts.json", good); await sleep(100); $("btn-confirm-load").click(); await sleep(150);
  R["replace project after finish works"] = $("run-badge").textContent === "Idle" && $("stat-pending").textContent === "3";
  $("btn-start").click(); await sleep(100);
  drop("test_prompts.json", good); await sleep(100); $("btn-confirm-load").click(); await sleep(100);
  R["UI-04 replace while running refused"] = $("toast").textContent.includes("Stop or pause");
  $("btn-stop").click(); await sleep(700); await refresh();
  R["stop -> Stopped, remaining pending"] = $("run-badge").textContent === "Stopped" && Number($("stat-pending").textContent) >= 1 && !$("btn-resume").disabled;
  R["UI-12 no horizontal overflow"] = document.documentElement.scrollWidth <= document.documentElement.clientWidth;
  R["viewport"] = `${document.documentElement.clientWidth}px`;
  delete R._lastAlert;
  window.__R = R;
  return R;
}
