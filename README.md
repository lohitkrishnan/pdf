# PDF Studio (`lohitkrishnan.com/pdf/`)

A 100% client-side, zero-upload browser PDF studio designed to run as a static GitHub Pages site at `https://lohitkrishnan.com/pdf/`. Sensitive documents never leave the browser tab.

## Workspaces & Capabilities

1. **Lock, Unlock & Compress PDF (Single or Batch)**
   - Inspects PDF version, page count, byte size, and encryption state (`Password Required`, `Permissions Locked`, or `Unencrypted`).
   - Removes user/owner passwords (`AES-256`, `AES-128`, `RC4`) via QPDF 12.2.0 WASM.
   - Compresses PDFs with **Lossless** (QPDF Flate L9 + object streams + image optimization), **Balanced** (150 DPI), or **Maximum** (96 DPI), with batch size deltas and `.zip` download.
   - Encrypts PDFs with separate optional User & Owner passwords, **256-bit AES (R6)** or **128-bit AES (R4)**, and granular print/modify/extract permissions.

2. **Merge, Split & Visual Page Organizer**
   - Combines multiple PDFs (auto-unlocking owner-locked files) and images (`.png`, `.jpg`, `.webp`).
   - Drag-and-drop reordering (plus a touch-friendly drag handle), keyboard nudge (`←`/`→`), Shift+click range selection, bulk rotate `90° CW`, duplicate, delete, reverse order, and `+ Blank Page`.
   - **Crop pages:** draw the area to keep (or type margins, or auto-trim to the content) and apply it to selected or all pages; crops turn with the page when rotated.
   - Exports losslessly merged PDFs, custom page range extractions (`1-3, 5`), or burst-splits every `N` pages into a `.zip` archive via a custom binary PKZIP writer.
   - **Export as Images:** JPG or PNG at 72/150/300 DPI for all or selected pages (single image or `.zip`), with the DPI recorded in each file.

3. **Fill Interactive Forms & Sign** *(shared document state with Workspace 4)*
   - Auto-detects interactive `AcroForm` text fields (including multi-line), checkboxes, radio groups, dropdowns and option lists in both the sidebar and interactive page hotspots, with optional field flattening on export.
   - Field values with characters outside the standard PDF fonts (e.g. `₹`) are drawn with an embedded Noto Sans; scripts the bundled font doesn't cover show as `?` in the field's appearance while the typed value is kept.
   - Draw, type (Cursive / Executive Serif / Official Stamp), or upload transparent signatures & stamps.

4. **Edit Text, Overlay, Whiteout & Confidential Redaction**
   - **Select & Edit Existing PDF Text In-Place:** Click any text span or drag across words to edit inline with automatic background-mask color sampling, ink color matching, and font style detection, plus Restore Original and Undo/Redo.
   - Add freeform text overlays, one-click `✓ Verified (YYYY-MM-DD)` stamps, whiteout masks, and **Confidential Redactions** with **200 DPI JPEG Burn-In Sanitization** (leaving untouched pages 100% vector while scrubbing metadata).

## Local Development

Serve the folder over HTTP (required for ES modules and WebAssembly):

```bash
python -m http.server 8765 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8765/`.

## Publishing to `lohitkrishnan.com/pdf/`

This repo is a GitHub Pages *project site* published from `main` / `/ (root)`. It appears at
`https://lohitkrishnan.com/pdf/` because the homepage repo is the account's *user site*
(`lohitkrishnan/lohitkrishnan.github.io`) with the custom domain `lohitkrishnan.com`: GitHub serves every
project site of the account under that domain. (If the homepage repo is ever renamed away from
`lohitkrishnan.github.io`, this tool falls back to `https://lohitkrishnan.github.io/pdf/`, which then
no longer redirects.)

To publish a change, run `python3 tools/update-sw.py` (see below), commit, and push to `main`;
Pages redeploys in a minute or two.

## Offline use and installing

`sw.js` is a service worker that caches the app (about 5.4 MB) on the first visit, so after that
PDF Studio opens and every feature works with no internet connection. `manifest.webmanifest`
lets browsers offer **Install** (Chrome, Edge, Android) or **Add to Home Screen** (Safari).
Only the app's own files are cached; PDFs the user opens are never stored.

On touch screens, finished files open a small sheet with **Share** and **Save to device**, the
main button of each tool stays pinned to the bottom of narrow screens, and **Take photo of a
page** adds a camera shot in Merge, Split & Pages. Desktop mouse users see none of this.

**Before every commit that changes a file the app loads**, regenerate the cache list and version:

```bash
python3 tools/update-sw.py
```

If you forget, visitors keep getting the previous version from their cache. When a new version
is published, open copies of the page show "A new version of PDF Studio is ready" with a Reload
button, so nobody loses work to a surprise refresh.
To link it from the homepage (`lohitkrishnan.com/index.html`), use the same section markup:

```html
<h2 class="section-title">Tools</h2>
<ul class="posts">
    <li class="post">
        <a class="post-title" href="/pdf/">PDF Studio</a>
        <span class="date">100% local in-browser PDF editor</span>
    </li>
</ul>
```

## Third-party files in `vendor/`

| File | Project | License |
| --- | --- | --- |
| `qpdf.js`, `qpdf.wasm` | QPDF 12 (WebAssembly build) | Apache-2.0 |
| `pdf-lib.min.js` | pdf-lib | MIT |
| `pdf.min.mjs`, `pdf.worker.min.mjs` | PDF.js | Apache-2.0 |
| `jspdf.umd.min.js` | jsPDF | MIT |
| `fontkit.umd.min.js` | @pdf-lib/fontkit 1.1.1 (loaded only when a form field needs a Unicode font) | MIT |
| `fonts/NotoSans-Regular.ttf` | Noto Sans, trimmed to Latin, Greek, Cyrillic, punctuation and currency symbols (used for form fields containing characters like ₹) | SIL Open Font License 1.1, see `fonts/OFL.txt` |
| `fonts/Lora-Variable.woff` (top-level `fonts/` folder) | Lora, the headings font shared with lohitkrishnan.com | SIL Open Font License 1.1 |

## Licence

The code in this repository is released under the [MIT License](LICENSE): you may use, change
and share it, including commercially, as long as the copyright notice stays with it.
Third-party files keep their own licences, listed above.

PDF Studio is part of [lohitkrishnan.com](https://lohitkrishnan.com). Its companion tool,
[Image Studio](https://lohitkrishnan.com/image/) ([source](https://github.com/lohitkrishnan/image)),
works the same way for photos.
