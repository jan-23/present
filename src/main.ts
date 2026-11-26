import Sortable from "sortablejs";
import { get, set } from "idb-keyval";

// Browser APIs missing from TS's DOM lib (File System Access + Window Management).
declare global {
  interface Window {
    showDirectoryPicker(opts?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
    getScreenDetails?(): Promise<{ screens: ScreenDetailed[]; currentScreen: ScreenDetailed }>;
  }
  interface ScreenDetailed extends Screen {
    availLeft: number;
    availTop: number;
    left: number;
    top: number;
  }
  interface FileSystemHandle {
    queryPermission(opts?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
    requestPermission(opts?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  }
}

type Item = { name: string; kind: "image" | "video"; url: string };
type MediaEl = HTMLImageElement | HTMLVideoElement;

const ORDER_FILE = ".present-order.json";
const IMAGE = /\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|ogv|mkv)$/i;

let dir: FileSystemDirectoryHandle | null = null;
let items: Item[] = [];
let current: string | null = null; // name of the selected item
let black = true;

// Second-screen window. It's a same-origin about:blank popup, so we drive its DOM directly.
// It holds one preloaded element per item; switching just changes which one is visible.
let screenWin: Window | null = null;
let screenEls = new Map<string, MediaEl>();
let vid: HTMLVideoElement | null = null; // the current video on the screen, if any
let hint: HTMLElement | null = null;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const header = $("header");
const grid = $("#grid");
const bar = $("#videobar");
const playBtn = $<HTMLButtonElement>("#play");
const seek = $<HTMLInputElement>("#seek");
const timeLabel = $("#time");
const jump = $<HTMLInputElement>("#jump");
const blackBtn = $<HTMLButtonElement>("#black");
const screenBtn = $<HTMLButtonElement>("#screen");
const sizeSlider = $<HTMLInputElement>("#size");

// ---------- folder + order ----------

async function loadFolder(handle: FileSystemDirectoryHandle) {
  items.forEach((i) => URL.revokeObjectURL(i.url));
  dir = handle;
  const found: Item[] = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== "file" || entry.name.startsWith(".")) continue;
    const kind = IMAGE.test(entry.name) ? "image" : VIDEO.test(entry.name) ? "video" : null;
    if (!kind) continue;
    const file = await (entry as FileSystemFileHandle).getFile();
    found.push({ name: entry.name, kind, url: URL.createObjectURL(file) });
  }
  // Alphabetical (natural) first, then saved order wins; new files end up at the back.
  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const rank = new Map((await readOrder()).map((n, i) => [n, i]));
  found.sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));
  items = found;
  if (current && !items.some((i) => i.name === current)) current = null;
  document.title = `Present – ${handle.name}`;
  $("#folder").textContent = handle.name;
  render();
  buildScreen();
  present();
}

async function readOrder(): Promise<string[]> {
  try {
    const file = await (await dir!.getFileHandle(ORDER_FILE)).getFile();
    return JSON.parse(await file.text());
  } catch {
    return [];
  }
}

async function saveOrder() {
  if (!dir) return;
  try {
    const w = await (await dir.getFileHandle(ORDER_FILE, { create: true })).createWritable();
    await w.write(JSON.stringify(items.map((i) => i.name), null, 2));
    await w.close();
  } catch (e) {
    alert(`Could not save order: ${e}`);
  }
}

async function openFolder() {
  const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "present" });
  await loadFolder(handle);
  set("dir", handle).catch(console.error); // remember for "Reopen last"
}

async function reopenFolder() {
  const handle = (await get("dir")) as FileSystemDirectoryHandle | undefined;
  if (!handle) return openFolder();
  if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
    if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return;
  }
  await loadFolder(handle);
}

// ---------- thumbnails ----------

function render() {
  grid.replaceChildren(
    ...items.map((item) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.name = item.name;
      let media: HTMLElement;
      if (item.kind === "image") {
        const el = document.createElement("img");
        el.src = item.url;
        el.loading = "lazy";
        el.decoding = "async";
        media = el;
      } else {
        const el = document.createElement("video");
        el.muted = true;
        el.preload = "metadata";
        el.src = item.url + "#t=1";
        media = el;
      }
      media.draggable = false;
      const label = document.createElement("div");
      label.className = "label";
      label.innerHTML = `<b></b> ${item.kind === "video" ? "▶ " : ""}<span></span>`;
      label.querySelector("span")!.textContent = item.name;
      tile.append(media, label);
      tile.addEventListener("click", () => show(items.findIndex((i) => i.name === item.name)));
      return tile;
    }),
  );
  $("#empty").hidden = items.length > 0;
  updateTiles();
}

/** Numbers, "current" (blue, red when blacked out) and "next" (dashed) markers. */
function updateTiles() {
  const nextName = items[currentIndex() + 1]?.name;
  grid.querySelectorAll<HTMLElement>(".tile").forEach((tile, i) => {
    const name = tile.dataset.name;
    tile.querySelector("b")!.textContent = String(i + 1);
    tile.classList.toggle("current", name === current);
    tile.classList.toggle("blacked", name === current && black);
    tile.classList.toggle("next", name === nextName);
  });
  blackBtn.classList.toggle("active", black);
}

/** Scroll so the current and the next tile are both visible (between header and video bar). */
let scrollTarget: number | null = null; // where a running smooth scroll is heading
window.addEventListener("scrollend", () => (scrollTarget = null));
function scrollToCurrent() {
  const tiles = [...grid.querySelectorAll<HTMLElement>(".current, .next")];
  if (!tiles.length) return;
  const base = scrollTarget ?? window.scrollY;
  // Page coordinates, as seen once the running scroll (if any) has finished.
  const rects = tiles.map((t) => t.getBoundingClientRect());
  const top = Math.min(...rects.map((r) => r.top)) + window.scrollY - base;
  const bottom = Math.max(...rects.map((r) => r.bottom)) + window.scrollY - base;
  const minY = header.offsetHeight + 8;
  const maxY = window.innerHeight - (bar.hidden ? 0 : bar.offsetHeight) - 8;
  let dy = 0;
  if (top < minY) dy = top - minY;
  else if (bottom > maxY) dy = Math.min(bottom - maxY, top - minY); // never push the current one off the top
  if (!dy) return;
  scrollTarget = base + dy;
  window.scrollTo({ top: scrollTarget, behavior: "smooth" });
}

Sortable.create(grid, {
  animation: 150,
  onEnd(e) {
    if (e.oldIndex === undefined || e.newIndex === undefined || e.oldIndex === e.newIndex) return;
    const [moved] = items.splice(e.oldIndex, 1);
    items.splice(e.newIndex, 0, moved);
    updateTiles();
    saveOrder();
  },
});

// Thumbnail size, remembered per browser.
function setThumbSize(px: number) {
  grid.style.setProperty("--thumb", `${px}px`);
  sizeSlider.value = String(px);
}
try {
  setThumbSize(Number(localStorage.getItem("thumb")) || 200);
} catch {
  setThumbSize(200);
}
sizeSlider.addEventListener("input", () => {
  setThumbSize(Number(sizeSlider.value));
  try {
    localStorage.setItem("thumb", sizeSlider.value);
  } catch {}
});

// ---------- presenting ----------

const currentItem = () => items.find((i) => i.name === current) ?? null;
const currentIndex = () => items.findIndex((i) => i.name === current);

function show(index: number) {
  if (index < 0 || index >= items.length) return;
  current = items[index].name;
  black = false;
  present();
}

function next() {
  show(Math.min(currentIndex() + 1, items.length - 1));
}
function prev() {
  show(Math.max(currentIndex() - 1, 0));
}

function toggleBlack() {
  black = !black;
  if (!black && !current && items.length) return show(0);
  applyBlack();
  updateTiles();
}

/** Make the current item the visible one on the screen; videos start from the beginning. */
function present() {
  vid = null;
  for (const [name, el] of screenEls) {
    const on = name === current;
    el.hidden = !on;
    if (el.tagName === "VIDEO") {
      const v = el as HTMLVideoElement;
      if (on) {
        vid = v;
        v.currentTime = 0;
      } else if (!v.paused) v.pause();
    }
  }
  applyBlack();
  updateTiles();
  updateVideoBar();
  scrollToCurrent();
}

/** Black hides the media and pauses video; un-blacking resumes where it was. */
function applyBlack() {
  screenWin?.document.body.classList.toggle("black", black);
  if (!vid) return;
  if (black) vid.pause();
  else play();
}

function play() {
  vid?.play().catch(() => showHint("Click here once to allow video playback with sound"));
}

// ---------- second screen window ----------

/** The screen that isn't the laptop's, if the browser lets us know (Window Management API). */
let otherScreen: ScreenDetailed | null = null;
async function findOtherScreen() {
  try {
    const details = await window.getScreenDetails!();
    otherScreen = details.screens.find((s) => s !== details.currentScreen) ?? null;
  } catch {
    otherScreen = null;
  }
}
// If permission was already given earlier, look it up now, so the click can open the window right away.
navigator.permissions
  ?.query({ name: "window-management" as PermissionName })
  .then((p) => {
    if (p.state === "granted") return findOtherScreen();
  })
  .catch(() => {});

async function openScreen() {
  if (screenWin && !screenWin.closed) return screenWin.focus();
  let asked = false;
  if (!otherScreen && window.getScreenDetails) {
    asked = true;
    await findOtherScreen(); // may show the permission prompt once
  }
  const s = otherScreen;
  const features = s
    ? `popup,fullscreen,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`
    : "popup,width=960,height=540";
  const w = window.open("", "present-screen", features);
  if (!w) {
    alert(asked ? "Click 🖥 Screen again to open the screen window." : "Popup blocked – allow popups for this page.");
    return;
  }
  screenWin = w;
  const d = w.document;
  d.title = "Present – Screen";
  d.head.innerHTML = `<style>
    html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}
    img,video{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
    [hidden],body.black img,body.black video{display:none!important}
    #hint{position:fixed;inset:auto 0 40% 0;text-align:center;font:24px system-ui;color:#aaa}
  </style>`;
  d.body.className = "";
  d.body.replaceChildren();
  hint = null;
  if (!s) showHint("Move this window to the second screen, then click here (or press F) for fullscreen");

  const fullscreen = () => {
    hint?.remove();
    if (!d.fullscreenElement) d.documentElement.requestFullscreen().catch(() => {});
    if (vid && vid.paused && !black) play();
  };
  d.onclick = fullscreen;
  d.onkeydown = (e) => (e.key === "f" || e.key === "F" ? fullscreen() : onKey(e));
  w.onpagehide = () => {
    screenWin = vid = hint = null;
    screenEls = new Map();
    screenBtn.classList.remove("active");
    updateVideoBar();
  };
  screenBtn.classList.add("active");
  buildScreen();
  present();
}

/** One element per item in the screen window, all preloaded, all but the current one hidden. */
function buildScreen() {
  if (!screenWin) return;
  const d = screenWin.document;
  screenEls.forEach((el) => {
    el.removeAttribute("src");
    if (el.tagName === "VIDEO") (el as HTMLVideoElement).load(); // free the decoder
    el.remove();
  });
  screenEls = new Map();
  vid = null;
  for (const item of items) {
    let el: MediaEl;
    if (item.kind === "image") {
      el = d.createElement("img");
      el.decoding = "sync"; // no flash of black when switching
    } else {
      const v = (el = d.createElement("video"));
      v.preload = "auto";
      v.loop = true;
      v.playsInline = true;
      for (const ev of ["timeupdate", "durationchange", "play", "pause", "seeked"]) {
        v.addEventListener(ev, () => v === vid && updateVideoBar());
      }
    }
    el.hidden = true;
    el.src = item.url;
    screenEls.set(item.name, el);
    d.body.prepend(el);
  }
}

function showHint(text: string) {
  if (!screenWin) return;
  if (!hint) {
    hint = screenWin.document.createElement("div");
    hint.id = "hint";
  }
  hint.textContent = text;
  screenWin.document.body.append(hint);
}

// ---------- video controls ----------

const fmt = (s: number) => {
  if (!isFinite(s)) return "0:00";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
};
const parseTime = (t: string) => t.trim().split(":").reduce((acc, part) => acc * 60 + Number(part), 0);

let seeking = false;
function updateVideoBar() {
  const isVideo = currentItem()?.kind === "video";
  bar.hidden = !isVideo;
  if (!isVideo || !vid) {
    timeLabel.textContent = isVideo ? "open the screen window first" : "";
    return;
  }
  seek.max = String(vid.duration || 0);
  if (!seeking) seek.value = String(vid.currentTime);
  timeLabel.textContent = `${fmt(vid.currentTime)} / ${fmt(vid.duration)}`;
  playBtn.textContent = vid.paused ? "▶ Play" : "⏸ Pause";
}

seek.addEventListener("pointerdown", () => (seeking = true));
seek.addEventListener("pointerup", () => (seeking = false));
seek.addEventListener("input", () => {
  if (vid) vid.currentTime = Number(seek.value);
});
playBtn.addEventListener("click", () => {
  if (!vid) return;
  if (vid.paused) {
    black = false;
    applyBlack();
    updateTiles();
  } else vid.pause();
});
$("#jumpform").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = parseTime(jump.value);
  if (vid && isFinite(t)) vid.currentTime = t;
  jump.blur();
});

// ---------- keyboard + buttons ----------

function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
  switch (e.key) {
    case " ":
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      e.preventDefault();
      next();
      break;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      e.preventDefault();
      prev();
      break;
    case "b":
    case "B":
    case ".": // presenter clickers send "." or "b" for black screen
      e.preventDefault();
      toggleBlack();
      break;
  }
}
window.addEventListener("keydown", onKey);
// Space on a focused button/slider would also act on it; controls never keep focus.
document.addEventListener("click", (e) => (e.target as HTMLElement).closest("button")?.blur());
document.addEventListener("pointerup", (e) => {
  if ((e.target as HTMLInputElement).type === "range") (e.target as HTMLElement).blur();
});

$("#open").addEventListener("click", () => openFolder().catch(console.error));
$("#reopen").addEventListener("click", () => reopenFolder().catch(console.error));
blackBtn.addEventListener("click", toggleBlack);
screenBtn.addEventListener("click", () => openScreen().catch(console.error));

if (!("showDirectoryPicker" in window)) {
  $("#empty").innerHTML = "This needs Chrome or Edge (File System Access API).";
}
get("dir").then((h) => {
  if (h) $("#reopen").textContent = `↻ ${(h as FileSystemDirectoryHandle).name}`;
});
