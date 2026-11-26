# Present

Dead simple local presenter for a folder of images and videos. No server, no install to run.

## Use

1. Open `index.html` in **Chrome or Edge** (needs the File System Access API).
2. **📁 Open folder** → pick the folder with your images and videos (allow edit access, so the order can be saved).
3. **🖥 Screen** → opens the output window fullscreen **directly on the second screen**
   (the first time, Chrome asks for the "window management" permission – allow it; if the window
   doesn't open right after that, click **🖥 Screen** once more).
   Without that permission it opens a normal window: drag it over and click it (or press `F`) for fullscreen.
   If Chrome blocks video autoplay with sound, the screen says so – click it once.

| Action | How |
| --- | --- |
| Show an item | Click its thumbnail |
| Next / previous | `Space`, `→`, `PageDown` / `←`, `PageUp` (works in both windows, and with presenter clickers) |
| Black screen (toggle) | `B`, `.` or the **⬛ Black** button. Turning black off resumes a video where it was |
| Reorder | Drag & drop thumbnails |
| Video time | Slider, play/pause, or type a time like `1:23` and press Enter |

- Images and videos are shown to **fit** the screen (letterboxed, never cropped). Videos start automatically and **loop**.
- The **next** item is preloaded in the screen window, so advancing is instant (nothing else is kept in memory).
- The current item is marked blue (red while blacked out), the next one dashed; the list scrolls so both stay visible.
- The slider top right sets the **thumbnail size**.
- The order is saved to `.present-order.json` inside the media folder. New files appear at the end.
- **↻ Reopen last** reopens the previous folder (also picks up new files).
- Supported: jpg, png, gif, webp, avif, svg, bmp, mp4, m4v, mov, webm, ogv, mkv (playback depends on the browser's codecs).

## Develop

```sh
npm install
npm run build      # bundles src/main.ts -> dist/present.js
npm run watch
npm run typecheck
```

`dist/present.js` is committed so `index.html` works straight from a checkout.
