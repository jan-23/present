import Sortable from "sortablejs";
import { get, set } from "idb-keyval";

// File System Access API bits missing from TS's DOM lib.
declare global {
  interface Window {
    showDirectoryPicker(opts?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission(opts?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
    requestPermission(opts?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  }
}

type Item = { name: string; kind: "image" | "video"; url: string };

const ORDER_FILE = ".present-order.json";
const IMAGE = /\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|ogv|mkv)$/i;

let dir: FileSystemDirectoryHandle | null = null;
let items: Item[] = [];
let current: string | null = null; // name of the selected item
let black = true;

// Second-screen window and its elements (we drive its DOM directly; it's same-origin about:blank).
let screenWin: Window | null = null;
let img: HTMLImageElement | null = null;
let vid: HTMLVideoElement | null = null;
let hint: HTMLElement | null = null;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const grid = $("#grid");
const bar = $("#videobar");
const playBtn = $<HTMLButtonElement>("#play");
const seek = $<HTMLInputElement>("#seek");
const timeLabel = $("#time");
const jump = $<HTMLInputElement>("#jump");
const blackBtn = $<HTMLButtonElement>("#black");
const screenBtn = $<HTMLButtonElement>("#screen");

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

function updateTiles() {
  grid.querySelectorAll<HTMLElement>(".tile").forEach((tile, i) => {
    tile.querySelector("b")!.textContent = String(i + 1);
    tile.classList.toggle("current", tile.dataset.name === current);
    tile.classList.toggle("blacked", tile.dataset.name === current && black);
  });
  blackBtn.classList.toggle("active", black);
  const sel = grid.querySelector(".current");
  sel?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

/** Put the current item on the second screen (restarts videos). */
function present() {
  updateTiles();
  updateVideoBar();
  if (!img || !vid) return;
  const item = currentItem();
  vid.pause();
  if (item?.kind === "image") {
    img.src = item.url;
    img.hidden = false;
    vid.hidden = true;
    vid.removeAttribute("src");
    vid.load();
  } else if (item?.kind === "video") {
    img.hidden = true;
    img.removeAttribute("src");
    vid.hidden = false;
    vid.src = item.url;
  } else {
    img.hidden = vid.hidden = true;
  }
  applyBlack();
}

/** Black hides the media and pauses video; un-blacking resumes where it was. */
function applyBlack() {
  if (!screenWin || !vid) return;
  screenWin.document.body.classList.toggle("black", black);
  if (black) vid.pause();
  else if (currentItem()?.kind === "video") play();
}

function play() {
  vid?.play().catch(() => showHint("Click here once to allow video playback with sound"));
}

// ---------- second screen window ----------

function openScreen() {
  const w = window.open("", "present-screen", "popup,width=960,height=540");
  if (!w) return alert("Popup blocked – allow popups for this page.");
  screenWin = w;
  const d = w.document;
  d.title = "Present – Screen";
  d.head.innerHTML = `<style>
    html,body{margin:0;height:100%;background:#000;overflow:hidden}
    body.fs{cursor:none}
    img,video{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
    [hidden],body.black img,body.black video{display:none!important}
    #hint{position:fixed;inset:auto 0 40% 0;text-align:center;font:24px system-ui;color:#aaa}
  </style>`;
  img = d.createElement("img");
  vid = d.createElement("video");
  vid.playsInline = true;
  hint = d.createElement("div");
  hint.id = "hint";
  hint.textContent = "Move this window to the second screen, then click here (or press F) for fullscreen";
  d.body.replaceChildren(img, vid, hint);
  d.body.className = "";

  const fullscreen = () => {
    hint?.remove();
    if (!d.fullscreenElement) d.documentElement.requestFullscreen().catch(() => {});
    if (vid && !vid.hidden && vid.paused && !black) play();
  };
  d.onclick = fullscreen;
  d.onkeydown = (e) => (e.key === "f" || e.key === "F" ? fullscreen() : onKey(e));
  d.onfullscreenchange = () => d.body.classList.toggle("fs", !!d.fullscreenElement);
  for (const ev of ["timeupdate", "durationchange", "play", "pause", "loadedmetadata"]) {
    vid.addEventListener(ev, updateVideoBar);
  }
  vid.addEventListener("loadeddata", () => {
    if (!black) play();
  });
  w.onpagehide = () => {
    screenWin = img = vid = hint = null;
    screenBtn.classList.remove("active");
    updateVideoBar();
  };
  screenBtn.classList.add("active");
  present();
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
    play();
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
  if ((e.target as HTMLElement).tagName === "INPUT") return;
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
// Space on a focused button would also "click" it on keyup; buttons never keep focus.
document.addEventListener("click", (e) => (e.target as HTMLElement).closest("button")?.blur());

$("#open").addEventListener("click", () => openFolder().catch(console.error));
$("#reopen").addEventListener("click", () => reopenFolder().catch(console.error));
blackBtn.addEventListener("click", toggleBlack);
screenBtn.addEventListener("click", openScreen);

if (!("showDirectoryPicker" in window)) {
  $("#empty").innerHTML = "This needs Chrome or Edge (File System Access API).";
}
get("dir").then((h) => {
  if (h) $("#reopen").textContent = `↻ ${(h as FileSystemDirectoryHandle).name}`;
});
