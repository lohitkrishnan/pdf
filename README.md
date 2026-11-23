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
   - Drag-and-drop reordering, keyboard nudge (`←`/`→`), bulk rotate `90° CW`, duplicate, delete, reverse order, and `+ Blank Page`.
   - Exports losslessly merged PDFs, custom page range extractions (`1-3, 5`), or burst-splits every `N` pages into a `.zip` archive via a custom binary PKZIP writer.

3. **Fill Interactive Forms & Sign** *(shared document state with Workspace 4)*
   - Auto-detects interactive `AcroForm` text fields, checkboxes, and dropdowns in both the sidebar and interactive page hotspots, with optional field flattening on export.
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

1. Create a public GitHub repository named **`pdf`** under `github.com/lohitkrishnan/pdf`.
2. Push this directory to the `main` branch (`git init`, `git add .`, `git commit -m "Initial PDF Studio"`, `git push -u origin main`).
3. In repository **Settings → Pages**, set **Deploy from a branch** (`main` / `/ (root)`). GitHub Pages will automatically serve it at `https://lohitkrishnan.com/pdf/`.
4. Link it from `lohitkrishnan.com/index.html` using the same section markup:

```html
<h2 class="section-title">Tools</h2>
<ul class="posts">
    <li class="post">
        <a class="post-title" href="/pdf/">PDF Studio</a>
        <span class="date">100% local in-browser PDF editor</span>
    </li>
</ul>
```
