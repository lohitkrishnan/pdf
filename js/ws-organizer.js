import { ensureUnlocked } from './qpdf-engine.js';
import {
    pdfjsLib,
    formatBytes,
    downloadBlob,
    readFileBytes,
    imageFileToPdfBytes,
    parsePageRange,
    isPdfFile,
    isImageFile,
    stripPdfExtension,
} from './pdf-utils.js';
import { openPreviewModal } from './preview-modal.js';
import { createZip, crc32 } from './zip.js';
import { createOrganizerSamples } from './samples.js';

export function initOrganizerWorkspace({ root, toast, handoffToEditor }) {
    const state = {
        docs: new Map(), // docId -> { id, name, bytes, pageCount }
        pages: [],       // { id, docId, docName, sourcePageIndex, rotationDelta, thumbnailDataUrl, isBlankA4, selected }
        draggedIndex: null,
        busy: false,
    };

    let nextDocId = 1;
    let nextPageId = 1;

    const dropzone = root.querySelector('#org-dropzone');
    const fileInput = root.querySelector('#org-file-input');
    const sampleBtn = root.querySelector('#org-sample-btn');
    const grid = root.querySelector('#org-grid');
    const emptyState = root.querySelector('#org-empty-state');
    const countLabel = root.querySelector('#org-count-label');

    const selectAllBtn = root.querySelector('#org-select-all');
    const deselectAllBtn = root.querySelector('#org-deselect-all');
    const rotateSelBtn = root.querySelector('#org-rotate-selected');
    const deleteSelBtn = root.querySelector('#org-delete-selected');
    const nudgeLeftBtn = root.querySelector('#org-nudge-left');
    const nudgeRightBtn = root.querySelector('#org-nudge-right');
    const reverseBtn = root.querySelector('#org-reverse-btn');
    const addBlankBtn = root.querySelector('#org-add-blank-btn');
    const clearAllBtn = root.querySelector('#org-clear-btn');

    const mergeDownloadBtn = root.querySelector('#org-merge-download-btn');
    const mergePreviewBtn = root.querySelector('#org-merge-preview-btn');
    const sendEditorBtn = root.querySelector('#org-send-editor-btn');

    const rangeInput = root.querySelector('#org-range-input');
    const extractDownloadBtn = root.querySelector('#org-extract-download-btn');
    const extractPreviewBtn = root.querySelector('#org-extract-preview-btn');

    const burstSizeInput = root.querySelector('#org-burst-size');
    const burstZipBtn = root.querySelector('#org-burst-zip-btn');

    const cropSelBtn = root.querySelector('#org-crop-selected');
    const imgFormatSel = root.querySelector('#org-img-format');
    const imgDpiSel = root.querySelector('#org-img-dpi');
    const imgScopeEl = root.querySelector('#org-img-scope');
    const imgExportBtn = root.querySelector('#org-img-export-btn');

    function promptPasswordModal(filename, wrongAttempt = false) {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'modal-backdrop';
            backdrop.innerHTML = `
                <div class="modal-dialog modal-dialog-sm">
                    <header class="modal-header">
                        <h3 class="modal-title">Password Required</h3>
                        <button type="button" class="btn btn-ghost btn-sm js-cancel">✕</button>
                    </header>
                    <form class="modal-body-pad js-form">
                        <p class="muted-text">Enter open password for <strong>${escapeHtml(filename)}</strong> to import its pages:</p>
                        ${wrongAttempt ? '<p class="preview-pw-error" role="alert">That password didn’t work. Try again.</p>' : ''}
                        <input type="password" class="input js-pw" placeholder="Open password" required autofocus />
                        <div class="modal-footer-btns">
                            <button type="button" class="btn btn-ghost btn-sm js-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary btn-sm">Unlock & Import</button>
                        </div>
                    </form>
                </div>
            `;
            document.body.appendChild(backdrop);

            const close = (val) => {
                backdrop.remove();
                resolve(val);
            };
            backdrop.querySelectorAll('.js-cancel').forEach((b) => b.addEventListener('click', () => close(null)));
            backdrop.querySelector('.js-form').addEventListener('submit', (e) => {
                e.preventDefault();
                close(backdrop.querySelector('.js-pw').value);
            });
            backdrop.querySelector('.js-pw').focus();
        });
    }

    async function renderSingleThumbnail(pdfDoc, item) {
        const page = await pdfDoc.getPage(item.sourcePageIndex + 1);
        item.intrinsicRotate = page.rotate || 0;
        const totalRotation = (item.intrinsicRotate + item.rotationDelta) % 360;
        const baseVp = page.getViewport({ scale: 1, rotation: totalRotation });
        const targetWidth = 176;
        const scale = targetWidth / baseVp.width;
        const vp = page.getViewport({ scale, rotation: totalRotation });

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vp.width));
        canvas.height = Math.max(1, Math.round(vp.height));
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        return cropCanvasToDataUrl(canvas, item.crop ? baseToVisual(item.crop, totalRotation) : null, 'image/jpeg');
    }

    function createBlankThumbnail(item) {
        const rotationDelta = item?.rotationDelta || 0;
        const canvas = document.createElement('canvas');
        const landscape = rotationDelta % 180 !== 0;
        canvas.width = landscape ? 176 : 124;
        canvas.height = landscape ? 124 : 176;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#d4cfc5';
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
        ctx.fillStyle = '#6f6a62';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Blank A4', canvas.width / 2, canvas.height / 2 + 4);
        return cropCanvasToDataUrl(canvas, item?.crop ? baseToVisual(item.crop, rotationDelta) : null, 'image/png');
    }

    // ---------- Crop geometry ----------
    // A page's crop is stored as margins {t, r, b, l}: fractions of the page's own *unrotated*
    // visible box to cut away from each side. Storing it unrotated means rotating a page later
    // turns the crop with it. The crop dialog works in visual (as-displayed) orientation.
    const SIDES = ['t', 'r', 'b', 'l'];
    function quarterTurns(rotation) {
        return ((Math.round(rotation / 90) % 4) + 4) % 4;
    }
    // A page shown rotated 90° clockwise has its left edge at the top, and so on.
    function visualToBase(vis, rotation) {
        const k = quarterTurns(rotation);
        const out = {};
        SIDES.forEach((side, i) => { out[side] = vis[SIDES[(i + k) % 4]]; });
        return out;
    }
    function baseToVisual(base, rotation) {
        const k = quarterTurns(rotation);
        const out = {};
        SIDES.forEach((side, i) => { out[side] = base[SIDES[(i - k + 4) % 4]]; });
        return out;
    }
    function isNoCrop(m) {
        return !m || SIDES.every((side) => (m[side] || 0) < 0.0005);
    }
    function totalRotationOf(item) {
        return ((item.intrinsicRotate || 0) + (item.rotationDelta || 0)) % 360;
    }

    function cropCanvasToDataUrl(canvas, vis, type) {
        if (isNoCrop(vis)) return canvas.toDataURL(type, 0.85);
        const sx = Math.round(vis.l * canvas.width);
        const sy = Math.round(vis.t * canvas.height);
        const sw = Math.max(1, Math.round(canvas.width * (1 - vis.l - vis.r)));
        const sh = Math.max(1, Math.round(canvas.height * (1 - vis.t - vis.b)));
        const out = document.createElement('canvas');
        out.width = sw;
        out.height = sh;
        out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        return out.toDataURL(type, 0.85);
    }

    // Shrinks the page's boxes to the crop. Content outside stays in the file (hidden, not removed).
    function applyCropToPage(page, crop) {
        if (isNoCrop(crop)) return;
        const media = page.getMediaBox();
        const cropBox = page.getCropBox();
        // Visible area is the CropBox clipped to the MediaBox (what viewers and pdf.js show).
        const x0 = Math.max(media.x, cropBox.x);
        const y0 = Math.max(media.y, cropBox.y);
        const x1 = Math.min(media.x + media.width, cropBox.x + cropBox.width);
        const y1 = Math.min(media.y + media.height, cropBox.y + cropBox.height);
        const w = x1 - x0;
        const h = y1 - y0;
        const x = x0 + crop.l * w;
        const y = y0 + crop.b * h;
        const cw = Math.max(1, w * (1 - crop.l - crop.r));
        const ch = Math.max(1, h * (1 - crop.t - crop.b));
        page.setMediaBox(x, y, cw, ch);
        page.setCropBox(x, y, cw, ch);
        page.setTrimBox(x, y, cw, ch);
        page.setBleedBox(x, y, cw, ch);
        page.setArtBox(x, y, cw, ch);
    }

    async function refreshThumbnailsForItems(items) {
        const byDoc = new Map();
        for (const item of items) {
            if (item.isBlankA4) {
                item.thumbnailDataUrl = createBlankThumbnail(item);
                continue;
            }
            if (!byDoc.has(item.docId)) byDoc.set(item.docId, []);
            byDoc.get(item.docId).push(item);
        }

        for (const [docId, docItems] of byDoc.entries()) {
            const docEntry = state.docs.get(docId);
            if (!docEntry) continue;
            const pdf = await pdfjsLib.getDocument({ data: docEntry.bytes.slice(0) }).promise;
            try {
                for (const item of docItems) {
                    item.thumbnailDataUrl = await renderSingleThumbnail(pdf, item);
                }
            } finally {
                await pdf.destroy();
            }
        }
    }

    function updateControls() {
        const total = state.pages.length;
        const selected = state.pages.filter((p) => p.selected).length;
        countLabel.textContent = total === 0
            ? 'No pages loaded'
            : `${total} page${total === 1 ? '' : 's'} (${selected} selected)`;

        emptyState.hidden = total > 0;
        const noPages = total === 0 || state.busy;
        const noSel = selected === 0 || state.busy;

        selectAllBtn.disabled = noPages;
        deselectAllBtn.disabled = noSel;
        rotateSelBtn.disabled = noSel;
        deleteSelBtn.disabled = noSel;
        nudgeLeftBtn.disabled = noSel;
        nudgeRightBtn.disabled = noSel;
        reverseBtn.disabled = total < 2 || state.busy;
        addBlankBtn.disabled = state.busy;
        clearAllBtn.disabled = noPages;

        mergeDownloadBtn.disabled = noPages;
        mergePreviewBtn.disabled = noPages;
        sendEditorBtn.disabled = noPages;
        extractDownloadBtn.disabled = noPages;
        extractPreviewBtn.disabled = noPages;
        burstZipBtn.disabled = noPages;
        cropSelBtn.disabled = noSel;
        imgExportBtn.disabled = noPages;
        imgScopeEl.textContent = selected > 0
            ? `${selected} selected page${selected === 1 ? '' : 's'}, one image each.${selected > 1 ? ' Downloads as a .zip.' : ''}`
            : 'All pages, one image each. More than one page downloads as a .zip.';
    }

    function nudgeSelected(direction) {
        const selectedCount = state.pages.filter((p) => p.selected).length;
        if (selectedCount === 0) return;

        const arr = [...state.pages];
        if (direction < 0) {
            for (let i = 1; i < arr.length; i++) {
                if (arr[i].selected && !arr[i - 1].selected) {
                    [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
                }
            }
        } else {
            for (let i = arr.length - 2; i >= 0; i--) {
                if (arr[i].selected && !arr[i + 1].selected) {
                    [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
                }
            }
        }
        state.pages = arr;
        renderGrid();
    }

    // Drop on the left half of a card inserts before it; the right half inserts after it.
    function dropIsAfter(card, clientX) {
        const r = card.getBoundingClientRect();
        return clientX > r.left + r.width / 2;
    }

    function markDropTarget(card, clientX) {
        const after = dropIsAfter(card, clientX);
        if (!card.classList.contains('is-drop-target') || card.classList.contains('is-drop-after') !== after) {
            clearDropMarkers();
            card.classList.add('is-drop-target');
            card.classList.toggle('is-drop-after', after);
        }
    }

    function clearDropMarkers() {
        grid.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target', 'is-drop-after'));
    }

    function movePage(from, target, after) {
        let insertAt = target + (after ? 1 : 0);
        if (from < insertAt) insertAt -= 1;
        if (insertAt === from) return;
        const [moved] = state.pages.splice(from, 1);
        state.pages.splice(insertAt, 0, moved);
    }

    // Pointer-based reorder from the drag handle. HTML5 drag-and-drop doesn't fire on touch
    // screens, so this is what makes reordering work on phones and tablets.
    function startPointerReorder(e, fromIndex, card) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        card.classList.add('is-dragging');
        let target = null;
        let after = false;
        let scrollTimer = null;

        const onMove = (ev) => {
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const over = el ? el.closest('.page-thumb-card') : null;
            if (over && over !== card && grid.contains(over)) {
                target = over;
                after = dropIsAfter(over, ev.clientX);
                markDropTarget(over, ev.clientX);
            } else if (!over) {
                target = null;
                clearDropMarkers();
            }
            // Auto-scroll near the top/bottom of the viewport so long documents can be reordered.
            clearInterval(scrollTimer);
            const edge = 60;
            const dy = ev.clientY < edge ? -12 : ev.clientY > window.innerHeight - edge ? 12 : 0;
            if (dy) scrollTimer = setInterval(() => window.scrollBy(0, dy), 16);
        };
        const finish = (commit) => {
            clearInterval(scrollTimer);
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onCancel);
            card.classList.remove('is-dragging');
            clearDropMarkers();
            if (commit && target) {
                movePage(fromIndex, Number(target.dataset.index), after);
                renderGrid();
            }
        };
        const onUp = () => finish(true);
        const onCancel = () => finish(false);
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onCancel);
    }

    // Click toggles one page; Shift+click applies the same state to the whole range since the last click.
    let lastSelectIndex = null;
    function setSelection(index, selected, extendRange) {
        if (extendRange && lastSelectIndex !== null && lastSelectIndex < state.pages.length) {
            const [a, b] = [Math.min(lastSelectIndex, index), Math.max(lastSelectIndex, index)];
            for (let i = a; i <= b; i++) state.pages[i].selected = selected;
        } else {
            state.pages[index].selected = selected;
        }
        lastSelectIndex = index;
        grid.querySelectorAll('.page-thumb-card').forEach((c, i) => {
            const on = Boolean(state.pages[i]?.selected);
            c.classList.toggle('is-selected', on);
            const cb = c.querySelector('.js-select');
            if (cb) cb.checked = on;
        });
        updateControls();
    }

    // Free the bytes of source documents that no longer have any pages in the grid.
    function pruneUnusedDocs() {
        const used = new Set(state.pages.map((p) => p.docId));
        for (const docId of [...state.docs.keys()]) {
            if (!used.has(docId)) state.docs.delete(docId);
        }
    }

    function renderGrid() {
        pruneUnusedDocs();
        grid.innerHTML = '';

        state.pages.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = `page-thumb-card ${item.selected ? 'is-selected' : ''}`;
            card.draggable = true;
            card.dataset.index = String(index);

            card.innerHTML = `
                <div class="thumb-top-bar">
                    <label class="thumb-select-wrap" title="Select page ${index + 1}">
                        <input type="checkbox" class="js-select" ${item.selected ? 'checked' : ''} />
                        <span class="thumb-num">#${index + 1}</span>
                    </label>
                    <button type="button" class="thumb-drag-handle js-drag-handle" title="Drag to reorder" aria-label="Drag page ${index + 1} to reorder">⠿</button>
                    ${item.rotationDelta ? `<span class="badge badge-neutral">${item.rotationDelta}°</span>` : ''}
                    ${!isNoCrop(item.crop) ? '<span class="badge badge-neutral badge-crop" title="Cropped">✂</span>' : ''}
                </div>
                <div class="thumb-img-wrap">
                    <img src="${item.thumbnailDataUrl}" alt="Page ${index + 1} from ${escapeHtml(item.docName)}" draggable="false" />
                </div>
                <div class="thumb-source" title="${escapeHtml(item.docName)}">
                    ${item.isBlankA4 ? 'Blank A4 Page' : `${escapeHtml(item.docName)} · p.${item.sourcePageIndex + 1}`}
                </div>
                <div class="thumb-actions">
                    <button type="button" class="btn btn-ghost btn-xs js-rotate" title="Rotate 90° CW">↻</button>
                    <button type="button" class="btn btn-ghost btn-xs js-dup" title="Duplicate page">⧉</button>
                    <button type="button" class="btn btn-ghost btn-xs js-del" title="Delete page">✕</button>
                </div>
            `;

            const selectBox = card.querySelector('.js-select');
            selectBox.addEventListener('click', (e) => {
                setSelection(index, selectBox.checked, e.shiftKey);
            });

            card.querySelector('.thumb-img-wrap').addEventListener('click', (e) => {
                setSelection(index, !item.selected, e.shiftKey);
            });

            card.querySelector('.js-rotate').addEventListener('click', async () => {
                item.rotationDelta = (item.rotationDelta + 90) % 360;
                await refreshThumbnailsForItems([item]);
                renderGrid();
            });

            card.querySelector('.js-dup').addEventListener('click', () => {
                const clone = { ...item, id: nextPageId++, selected: false };
                state.pages.splice(index + 1, 0, clone);
                renderGrid();
            });

            card.querySelector('.js-del').addEventListener('click', () => {
                state.pages.splice(index, 1);
                renderGrid();
            });

            // Drag & drop reorder (mouse: HTML5 drag; touch/pen/mouse: the ⠿ handle)
            card.addEventListener('dragstart', (e) => {
                state.draggedIndex = index;
                card.classList.add('is-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(index));
            });
            card.addEventListener('dragend', () => {
                state.draggedIndex = null;
                card.classList.remove('is-dragging');
                clearDropMarkers();
            });
            card.addEventListener('dragover', (e) => {
                if (state.draggedIndex === null || state.draggedIndex === index) return;
                e.preventDefault();
                markDropTarget(card, e.clientX);
            });
            card.addEventListener('dragleave', () => {
                card.classList.remove('is-drop-target', 'is-drop-after');
            });
            card.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const after = dropIsAfter(card, e.clientX);
                clearDropMarkers();
                if (state.draggedIndex === null || state.draggedIndex === index) return;
                movePage(state.draggedIndex, index, after);
                state.draggedIndex = null;
                renderGrid();
            });

            const handle = card.querySelector('.js-drag-handle');
            handle.addEventListener('pointerdown', (e) => startPointerReorder(e, index, card));

            grid.appendChild(card);
        });

        updateControls();
    }

    async function ingestPdfBytes(name, rawBytes, initialPassword = '') {
        let unlockedBytes;
        try {
            unlockedBytes = await ensureUnlocked(rawBytes, initialPassword);
        } catch (err) {
            if (err && (err.code === 'PASSWORD_REQUIRED' || err.code === 'INVALID_PASSWORD')) {
                // Keep asking until the password works or the person cancels.
                let wrong = Boolean(initialPassword);
                for (;;) {
                    const entered = await promptPasswordModal(name, wrong);
                    if (!entered) {
                        toast(`Skipped "${name}" (password required).`, 'warn');
                        return;
                    }
                    try {
                        unlockedBytes = await ensureUnlocked(rawBytes, entered);
                        break;
                    } catch (retryErr) {
                        if (retryErr && (retryErr.code === 'PASSWORD_REQUIRED' || retryErr.code === 'INVALID_PASSWORD')) {
                            wrong = true;
                            continue;
                        }
                        throw retryErr;
                    }
                }
            } else {
                throw err;
            }
        }

        const pdf = await pdfjsLib.getDocument({ data: unlockedBytes.slice(0) }).promise;
        const docId = nextDocId++;
        const docEntry = {
            id: docId,
            name,
            bytes: unlockedBytes,
            pageCount: pdf.numPages,
        };
        state.docs.set(docId, docEntry);

        try {
            for (let i = 0; i < pdf.numPages; i++) {
                const item = {
                    id: nextPageId++,
                    docId,
                    docName: name,
                    sourcePageIndex: i,
                    rotationDelta: 0,
                    intrinsicRotate: 0,
                    crop: null,
                    thumbnailDataUrl: '',
                    isBlankA4: false,
                    selected: false,
                };
                item.thumbnailDataUrl = await renderSingleThumbnail(pdf, item);
                state.pages.push(item);
            }
        } finally {
            await pdf.destroy();
        }
    }

    async function handleFiles(fileList) {
        const files = Array.from(fileList || []);
        const valid = files.filter((f) => isPdfFile(f) || isImageFile(f));
        if (valid.length === 0) {
            toast('Drop or select .pdf, .png, .jpg, or .webp files.', 'warn');
            return;
        }

        state.busy = true;
        updateControls();

        try {
            for (const file of valid) {
                if (isImageFile(file)) {
                    const pdfBytes = await imageFileToPdfBytes(file);
                    await ingestPdfBytes(file.name, pdfBytes);
                } else {
                    const rawBytes = await readFileBytes(file);
                    await ingestPdfBytes(file.name, rawBytes);
                }
            }
            renderGrid();
            toast(`Added ${valid.length} file${valid.length === 1 ? '' : 's'} to organizer.`, 'ok');
        } catch (err) {
            toast(err?.message || 'Failed to load files into organizer.', 'error');
        } finally {
            state.busy = false;
            renderGrid();
        }
    }

    async function ingestHandoff(entries) {
        state.busy = true;
        updateControls();
        try {
            for (const entry of entries) {
                await ingestPdfBytes(entry.name, entry.bytes, entry.password || '');
            }
            renderGrid();
        } catch (err) {
            toast(err?.message || 'Could not import handoff PDFs.', 'error');
        } finally {
            state.busy = false;
            renderGrid();
        }
    }

    /**
     * Assemble a subset (or all) of `state.pages` losslessly via pdf-lib.
     */
    async function buildPdfFromItems(pageItems) {
        const { PDFDocument, degrees } = window.PDFLib;
        const outDoc = await PDFDocument.create();
        const loadedSources = new Map();

        for (const item of pageItems) {
            if (item.isBlankA4) {
                const blank = outDoc.addPage([595.28, 841.89]);
                if (item.rotationDelta) {
                    blank.setRotation(degrees(item.rotationDelta));
                }
                applyCropToPage(blank, item.crop);
                continue;
            }

            let srcDoc = loadedSources.get(item.docId);
            if (!srcDoc) {
                const entry = state.docs.get(item.docId);
                srcDoc = await PDFDocument.load(entry.bytes, { ignoreEncryption: true });
                loadedSources.set(item.docId, srcDoc);
            }

            const [copied] = await outDoc.copyPages(srcDoc, [item.sourcePageIndex]);
            const existingAngle = copied.getRotation().angle || 0;
            copied.setRotation(degrees((existingAngle + item.rotationDelta) % 360));
            applyCropToPage(copied, item.crop);
            outDoc.addPage(copied);
        }

        return new Uint8Array(await outDoc.save());
    }

    function suggestedBaseName() {
        const firstReal = state.pages.find((p) => !p.isBlankA4);
        return firstReal ? stripPdfExtension(firstReal.docName) : 'organized_document';
    }

    // Bind UI actions
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    });
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('is-dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('is-dragover');
        handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
        fileInput.value = '';
    });

    selectAllBtn.addEventListener('click', () => {
        state.pages.forEach((p) => { p.selected = true; });
        renderGrid();
    });
    deselectAllBtn.addEventListener('click', () => {
        state.pages.forEach((p) => { p.selected = false; });
        renderGrid();
    });

    rotateSelBtn.addEventListener('click', async () => {
        const sel = state.pages.filter((p) => p.selected);
        if (sel.length === 0) return;
        sel.forEach((p) => { p.rotationDelta = (p.rotationDelta + 90) % 360; });
        await refreshThumbnailsForItems(sel);
        renderGrid();
    });

    deleteSelBtn.addEventListener('click', () => {
        state.pages = state.pages.filter((p) => !p.selected);
        renderGrid();
    });

    nudgeLeftBtn.addEventListener('click', () => nudgeSelected(-1));
    nudgeRightBtn.addEventListener('click', () => nudgeSelected(1));

    reverseBtn.addEventListener('click', () => {
        state.pages.reverse();
        renderGrid();
    });

    addBlankBtn.addEventListener('click', () => {
        state.pages.push({
            id: nextPageId++,
            docId: null,
            docName: 'Blank A4',
            sourcePageIndex: 0,
            rotationDelta: 0,
            thumbnailDataUrl: createBlankThumbnail(null),
            isBlankA4: true,
            selected: false,
        });
        renderGrid();
    });

    clearAllBtn.addEventListener('click', () => {
        state.docs.clear();
        state.pages = [];
        renderGrid();
    });

    // Keyboard nudging & deletion when organizer tab is active
    document.addEventListener('keydown', (e) => {
        if (root.hidden) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (document.body.classList.contains('modal-open')) return;

        if (e.key === 'ArrowLeft') {
            if (state.pages.some((p) => p.selected)) {
                e.preventDefault();
                nudgeSelected(-1);
            }
        } else if (e.key === 'ArrowRight') {
            if (state.pages.some((p) => p.selected)) {
                e.preventDefault();
                nudgeSelected(1);
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (state.pages.some((p) => p.selected)) {
                e.preventDefault();
                state.pages = state.pages.filter((p) => !p.selected);
                renderGrid();
            }
        }
    });

    mergeDownloadBtn.addEventListener('click', async () => {
        if (state.pages.length === 0) return;
        state.busy = true;
        updateControls();
        try {
            const bytes = await buildPdfFromItems(state.pages);
            const filename = `${suggestedBaseName()}_merged.pdf`;
            downloadBlob(bytes, filename, 'application/pdf');
            toast(`Merged ${state.pages.length} pages (${formatBytes(bytes.byteLength)}).`, 'ok');
        } catch (err) {
            toast(err?.message || 'Failed to merge pages.', 'error');
        } finally {
            state.busy = false;
            updateControls();
        }
    });

    mergePreviewBtn.addEventListener('click', async () => {
        if (state.pages.length === 0) return;
        state.busy = true;
        updateControls();
        try {
            const bytes = await buildPdfFromItems(state.pages);
            await openPreviewModal({ bytes, filename: `${suggestedBaseName()}_merged.pdf` });
        } catch (err) {
            toast(err?.message || 'Failed to build preview.', 'error');
        } finally {
            state.busy = false;
            updateControls();
        }
    });

    sendEditorBtn.addEventListener('click', async () => {
        if (state.pages.length === 0) return;
        state.busy = true;
        updateControls();
        try {
            const bytes = await buildPdfFromItems(state.pages);
            await handoffToEditor({
                name: `${suggestedBaseName()}_merged.pdf`,
                bytes,
            });
        } catch (err) {
            toast(err?.message || 'Failed to send merged PDF to editor.', 'error');
        } finally {
            state.busy = false;
            updateControls();
        }
    });

    async function runExtract(previewOnly) {
        if (state.pages.length === 0) return;
        let indices;
        try {
            indices = parsePageRange(rangeInput.value, state.pages.length);
        } catch (err) {
            toast(err.message, 'warn');
            rangeInput.focus();
            return;
        }

        state.busy = true;
        updateControls();
        try {
            const subset = indices.map((n) => state.pages[n - 1]);
            const bytes = await buildPdfFromItems(subset);
            const filename = `${suggestedBaseName()}_extracted.pdf`;
            if (previewOnly) {
                await openPreviewModal({ bytes, filename });
            } else {
                downloadBlob(bytes, filename, 'application/pdf');
                toast(`Extracted ${subset.length} page${subset.length === 1 ? '' : 's'}.`, 'ok');
            }
        } catch (err) {
            toast(err?.message || 'Extraction failed.', 'error');
        } finally {
            state.busy = false;
            updateControls();
        }
    }

    extractDownloadBtn.addEventListener('click', () => runExtract(false));
    extractPreviewBtn.addEventListener('click', () => runExtract(true));

    burstZipBtn.addEventListener('click', async () => {
        if (state.pages.length === 0) return;
        const n = Math.max(1, Number.parseInt(burstSizeInput.value, 10) || 1);
        burstSizeInput.value = String(n);

        state.busy = true;
        updateControls();
        try {
            const base = suggestedBaseName();
            const entries = [];
            for (let start = 0; start < state.pages.length; start += n) {
                const chunk = state.pages.slice(start, start + n);
                const bytes = await buildPdfFromItems(chunk);
                const pStart = start + 1;
                const pEnd = start + chunk.length;
                const label = pStart === pEnd ? `page_${pStart}` : `pages_${pStart}-${pEnd}`;
                entries.push({ name: `${base}_${label}.pdf`, data: bytes });
            }
            const zipBytes = createZip(entries);
            downloadBlob(zipBytes, `${base}_split_${entries.length}.zip`, 'application/zip');
            toast(`Split into ${entries.length} PDFs inside .zip archive.`, 'ok');
        } catch (err) {
            toast(err?.message || 'Burst split failed.', 'error');
        } finally {
            state.busy = false;
            updateControls();
        }
    });

    // ---------- Crop dialog ----------
    async function renderPageForCrop(item, maxW, maxH) {
        const rotation = totalRotationOf(item);
        if (item.isBlankA4) {
            const landscape = rotation % 180 !== 0;
            const [w, h] = landscape ? [841.89, 595.28] : [595.28, 841.89];
            const scale = Math.min(maxW / w, maxH / h);
            const c = document.createElement('canvas');
            c.width = Math.round(w * scale);
            c.height = Math.round(h * scale);
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, c.width, c.height);
            return c;
        }
        const entry = state.docs.get(item.docId);
        const pdf = await pdfjsLib.getDocument({ data: entry.bytes.slice(0) }).promise;
        try {
            const page = await pdf.getPage(item.sourcePageIndex + 1);
            const base = page.getViewport({ scale: 1, rotation });
            const scale = Math.min(maxW / base.width, maxH / base.height);
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const vp = page.getViewport({ scale: scale * dpr, rotation });
            const c = document.createElement('canvas');
            c.width = Math.round(vp.width);
            c.height = Math.round(vp.height);
            c.style.width = `${Math.round(vp.width / dpr)}px`;
            const ctx = c.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, c.width, c.height);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            return c;
        } finally {
            await pdf.destroy();
        }
    }

    // Bounding box of non-background pixels, as visual margins with a little padding.
    function detectContentMargins(canvas) {
        const { width, height } = canvas;
        const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
        // Background = the most common colour around the page edge (not just the corner pixel, which
        // may sit on a full-width header bar). Full-bleed bars then count as content and are kept.
        const buckets = new Map();
        const sample = (x, y) => {
            const i = (y * width + x) * 4;
            const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
            const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
            b.n += 1;
            b.r += data[i];
            b.g += data[i + 1];
            b.b += data[i + 2];
            buckets.set(key, b);
        };
        const edgeStep = Math.max(1, Math.floor(Math.max(width, height) / 400));
        for (let x = 0; x < width; x += edgeStep) {
            sample(x, 0);
            sample(x, height - 1);
        }
        for (let y = 0; y < height; y += edgeStep) {
            sample(0, y);
            sample(width - 1, y);
        }
        const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
        const bg = [top.r / top.n, top.g / top.n, top.b / top.n];
        let minX = width, minY = height, maxX = -1, maxY = -1;
        const step = Math.max(1, Math.floor(Math.min(width, height) / 500));
        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const i = (y * width + x) * 4;
                if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 36) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        const pad = 0.015;
        return {
            l: Math.max(0, minX / width - pad),
            t: Math.max(0, minY / height - pad),
            r: Math.max(0, 1 - (maxX + step) / width - pad),
            b: Math.max(0, 1 - (maxY + step) / height - pad),
        };
    }

    let cropDialogOpen = false;
    async function openCropDialog() {
        // One dialog at a time (focus can stay on the Crop button, so Enter could fire it twice).
        if (cropDialogOpen) return;
        const selectedItems = state.pages.filter((p) => p.selected);
        if (selectedItems.length === 0) return;
        cropDialogOpen = true;
        const opener = document.activeElement;
        const ref = selectedItems[0];
        const refRotation = totalRotationOf(ref);
        let vis = ref.crop ? baseToVisual(ref.crop, refRotation) : { t: 0, r: 0, b: 0, l: 0 };
        const MIN = 0.05; // the kept area is at least 5% of the page in each direction

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML = `
            <div class="modal-dialog crop-dialog" role="dialog" aria-modal="true" aria-labelledby="crop-title">
                <header class="modal-header">
                    <h3 class="modal-title" id="crop-title">Crop pages</h3>
                    <button type="button" class="btn btn-ghost btn-sm js-cancel" aria-label="Close">✕</button>
                </header>
                <div class="crop-body">
                    <div class="crop-stage js-stage"><div class="muted-text">Rendering page…</div></div>
                    <div class="crop-controls">
                        <p class="muted-text crop-note">Drag on the page to draw the area to keep, or drag the box and its corners.</p>
                        <div class="crop-margins">
                            ${['t', 'r', 'b', 'l'].map((k) => `
                                <div>
                                    <label class="field-label" for="crop-${k}">${{ t: 'Top', r: 'Right', b: 'Bottom', l: 'Left' }[k]} %</label>
                                    <input type="number" id="crop-${k}" class="input input-sm js-margin" data-side="${k}" min="0" max="95" step="0.5" />
                                </div>`).join('')}
                        </div>
                        <div class="btn-row">
                            <button type="button" class="btn btn-ghost btn-xs js-auto">Auto-trim margins</button>
                            <button type="button" class="btn btn-ghost btn-xs js-reset">Reset</button>
                        </div>
                        <fieldset class="crop-scope">
                            <legend class="field-label">Apply to</legend>
                            <label class="checkbox-row"><input type="radio" name="crop-scope" value="selected" checked /> <span>Selected pages (${selectedItems.length})</span></label>
                            <label class="checkbox-row"><input type="radio" name="crop-scope" value="all" /> <span>All pages (${state.pages.length})</span></label>
                        </fieldset>
                        <p class="muted-text crop-note">Cropping hides everything outside the box, but it stays in the file. To remove sensitive content, use Redact instead.</p>
                        <div class="modal-footer-btns">
                            <button type="button" class="btn btn-ghost btn-sm js-cancel">Cancel</button>
                            <button type="button" class="btn btn-primary btn-sm js-apply">Apply crop</button>
                        </div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        document.body.classList.add('modal-open'); // pauses the grid's keyboard shortcuts

        const stage = backdrop.querySelector('.js-stage');
        const inputs = [...backdrop.querySelectorAll('.js-margin')];
        let canvas = null;
        let rectEl = null;

        const close = () => {
            document.removeEventListener('keydown', onKey);
            document.body.classList.remove('modal-open');
            backdrop.remove();
            cropDialogOpen = false;
            if (opener && opener.isConnected) opener.focus();
        };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        backdrop.querySelectorAll('.js-cancel').forEach((b) => b.addEventListener('click', close));

        const clampVis = (v) => {
            const out = { ...v };
            for (const k of SIDES) out[k] = Math.min(0.95, Math.max(0, out[k] || 0));
            if (1 - out.l - out.r < MIN) {
                const over = out.l + out.r - (1 - MIN);
                out.l -= over / 2;
                out.r -= over / 2;
            }
            if (1 - out.t - out.b < MIN) {
                const over = out.t + out.b - (1 - MIN);
                out.t -= over / 2;
                out.b -= over / 2;
            }
            return out;
        };
        const sync = (fromInputs = false) => {
            vis = clampVis(vis);
            if (rectEl) {
                rectEl.style.left = `${vis.l * 100}%`;
                rectEl.style.top = `${vis.t * 100}%`;
                rectEl.style.width = `${(1 - vis.l - vis.r) * 100}%`;
                rectEl.style.height = `${(1 - vis.t - vis.b) * 100}%`;
            }
            if (!fromInputs) {
                inputs.forEach((inp) => { inp.value = (vis[inp.dataset.side] * 100).toFixed(1); });
            }
        };
        inputs.forEach((inp) => inp.addEventListener('input', () => {
            vis[inp.dataset.side] = (Number(inp.value) || 0) / 100;
            sync(true);
        }));
        sync();

        // Wire the buttons before rendering, so Apply works even if the preview is slow or fails.
        backdrop.querySelector('.js-reset').addEventListener('click', () => {
            vis = { t: 0, r: 0, b: 0, l: 0 };
            sync();
        });
        backdrop.querySelector('.js-auto').addEventListener('click', () => {
            if (!canvas) {
                toast('The page preview is still loading.', 'warn');
                return;
            }
            const m = detectContentMargins(canvas);
            if (!m) {
                toast('This page looks blank, so there is nothing to trim to.', 'warn');
                return;
            }
            vis = m;
            sync();
        });

        backdrop.querySelector('.js-apply').addEventListener('click', async () => {
            const scope = backdrop.querySelector('input[name="crop-scope"]:checked').value;
            const targets = scope === 'all' ? state.pages : selectedItems;
            const finalVis = clampVis(vis);
            for (const item of targets) {
                // The same visual margins on every page, converted to each page's own orientation.
                item.crop = isNoCrop(finalVis) ? null : visualToBase(finalVis, totalRotationOf(item));
            }
            close();
            await refreshThumbnailsForItems(targets);
            renderGrid();
            toast(isNoCrop(finalVis)
                ? `Removed the crop from ${targets.length} page${targets.length === 1 ? '' : 's'}.`
                : `Cropped ${targets.length} page${targets.length === 1 ? '' : 's'}.`, 'ok');
        });
        backdrop.querySelector('.js-margin')?.focus();

        canvas = await renderPageForCrop(ref, 460, Math.min(560, window.innerHeight * 0.62)).catch(() => null);
        if (!backdrop.isConnected) return;
        if (!canvas) {
            stage.innerHTML = '<div class="muted-text">Could not render this page.</div>';
            return;
        }
        stage.replaceChildren(canvas);
        rectEl = document.createElement('div');
        rectEl.className = 'crop-rect';
        rectEl.innerHTML = ['nw', 'ne', 'sw', 'se'].map((h) => `<span class="crop-handle" data-h="${h}"></span>`).join('');
        stage.appendChild(rectEl);
        sync();

        // Pointer interaction: draw a new box, move the box, or drag a corner.
        const toFrac = (e) => {
            const r = canvas.getBoundingClientRect();
            return {
                x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
                y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
            };
        };
        stage.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            stage.setPointerCapture(e.pointerId);
            const start = toFrac(e);
            const startVis = { ...vis };
            const handle = e.target.closest('.crop-handle')?.dataset.h;
            const mode = handle ? 'resize' : e.target.closest('.crop-rect') ? 'move' : 'draw';
            const onMove = (ev) => {
                const p = toFrac(ev);
                if (mode === 'draw') {
                    vis = { l: Math.min(start.x, p.x), r: 1 - Math.max(start.x, p.x), t: Math.min(start.y, p.y), b: 1 - Math.max(start.y, p.y) };
                } else if (mode === 'move') {
                    const w = 1 - startVis.l - startVis.r;
                    const h = 1 - startVis.t - startVis.b;
                    const l = Math.min(1 - w, Math.max(0, startVis.l + p.x - start.x));
                    const t = Math.min(1 - h, Math.max(0, startVis.t + p.y - start.y));
                    vis = { l, t, r: 1 - w - l, b: 1 - h - t };
                } else {
                    vis = { ...startVis };
                    if (handle.includes('w')) vis.l = Math.min(p.x, 1 - startVis.r - MIN);
                    if (handle.includes('e')) vis.r = Math.min(1 - p.x, 1 - startVis.l - MIN);
                    if (handle.includes('n')) vis.t = Math.min(p.y, 1 - startVis.b - MIN);
                    if (handle.includes('s')) vis.b = Math.min(1 - p.y, 1 - startVis.t - MIN);
                }
                sync();
            };
            const onUp = () => {
                stage.removeEventListener('pointermove', onMove);
                stage.removeEventListener('pointerup', onUp);
                stage.removeEventListener('pointercancel', onUp);
                // A click without a drag in "draw" mode shouldn't collapse the box.
                if (mode === 'draw' && (1 - vis.l - vis.r < 0.02 || 1 - vis.t - vis.b < 0.02)) {
                    vis = startVis;
                    sync();
                }
            };
            stage.addEventListener('pointermove', onMove);
            stage.addEventListener('pointerup', onUp);
            stage.addEventListener('pointercancel', onUp);
        });

    }

    cropSelBtn.addEventListener('click', () => openCropDialog());

    // ---------- Export pages as images ----------
    const MAX_IMAGE_PIXELS = 40_000_000; // keeps canvases within browser limits
    const MAX_IMAGE_SIDE = 16_000;

    // Record the DPI in the file so print and layout apps use the intended physical size.
    function setJpegDpi(bytes, dpi) {
        // JFIF APP0: FF D8 FF E0 len(2) "JFIF\0" version(2) units(1) Xdensity(2) Ydensity(2)
        if (bytes[2] === 0xff && bytes[3] === 0xe0 && bytes[6] === 0x4a && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46) {
            bytes[13] = 1;
            bytes[14] = (dpi >> 8) & 0xff;
            bytes[15] = dpi & 0xff;
            bytes[16] = (dpi >> 8) & 0xff;
            bytes[17] = dpi & 0xff;
        }
        return bytes;
    }
    function setPngDpi(bytes, dpi) {
        // Insert a pHYs chunk (pixels per metre) right after IHDR (8-byte signature + 25-byte IHDR).
        const ppm = Math.round(dpi / 0.0254);
        const chunk = new Uint8Array(21);
        const view = new DataView(chunk.buffer);
        view.setUint32(0, 9);
        chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
        view.setUint32(8, ppm);
        view.setUint32(12, ppm);
        chunk[16] = 1; // unit: metre
        view.setUint32(17, crc32(chunk.subarray(4, 17)));
        const out = new Uint8Array(bytes.length + chunk.length);
        out.set(bytes.subarray(0, 33), 0);
        out.set(chunk, 33);
        out.set(bytes.subarray(33), 33 + chunk.length);
        return out;
    }

    imgExportBtn.addEventListener('click', async () => {
        if (state.pages.length === 0) return;
        const selectedItems = state.pages.filter((p) => p.selected);
        const items = selectedItems.length > 0 ? selectedItems : state.pages;
        const format = imgFormatSel.value === 'png' ? 'png' : 'jpg';
        const mime = format === 'png' ? 'image/png' : 'image/jpeg';
        const dpi = Number(imgDpiSel.value) || 150;
        const base = suggestedBaseName();
        const digits = String(state.pages.length).length;
        const label = imgExportBtn.textContent;

        state.busy = true;
        updateControls();
        let pdf = null;
        try {
            // Build from the page list so rotation and crop are included.
            const bytes = await buildPdfFromItems(items);
            pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
            const entries = [];
            let reduced = false;
            for (let i = 1; i <= pdf.numPages; i++) {
                imgExportBtn.textContent = `Rendering ${i} / ${pdf.numPages}…`;
                const page = await pdf.getPage(i);
                let scale = dpi / 72;
                let vp = page.getViewport({ scale });
                const shrink = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (vp.width * vp.height)), MAX_IMAGE_SIDE / Math.max(vp.width, vp.height));
                if (shrink < 1) {
                    scale *= shrink;
                    vp = page.getViewport({ scale });
                    reduced = true;
                }
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.floor(vp.width));
                canvas.height = Math.max(1, Math.floor(vp.height));
                const ctx = canvas.getContext('2d', { alpha: false });
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvasContext: ctx, viewport: vp }).promise;
                const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.92));
                canvas.width = 0;
                canvas.height = 0;
                if (!blob) throw new Error('The browser could not encode this page as an image.');
                let data = new Uint8Array(await blob.arrayBuffer());
                const effectiveDpi = Math.round(scale * 72);
                data = format === 'png' ? setPngDpi(data, effectiveDpi) : setJpegDpi(data, effectiveDpi);
                const pageNo = String(state.pages.indexOf(items[i - 1]) + 1).padStart(digits, '0');
                entries.push({ name: `${base}_page_${pageNo}.${format}`, data });
            }

            if (entries.length === 1) {
                downloadBlob(entries[0].data, entries[0].name, mime);
            } else {
                downloadBlob(createZip(entries), `${base}_${format}_${dpi}dpi.zip`, 'application/zip');
            }
            toast(`Exported ${entries.length} image${entries.length === 1 ? '' : 's'}${reduced ? ' (very large pages were scaled down to fit browser limits)' : ''}.`, 'ok');
        } catch (err) {
            toast(err?.message || 'Image export failed.', 'error');
        } finally {
            if (pdf) await pdf.destroy();
            imgExportBtn.textContent = label;
            state.busy = false;
            updateControls();
        }
    });

    sampleBtn.addEventListener('click', async () => {
        sampleBtn.disabled = true;
        sampleBtn.textContent = 'Generating sample PDFs…';
        try {
            const samples = await createOrganizerSamples();
            await ingestHandoff(samples);
            toast('Loaded 2 sample multi-page PDFs (5 pages total).', 'ok');
        } catch (err) {
            toast(err?.message || 'Could not generate sample PDFs.', 'error');
        } finally {
            sampleBtn.disabled = false;
            sampleBtn.textContent = 'Load 2 Sample Multi-Page PDFs';
        }
    });

    renderGrid();

    return {
        handleFiles,
        ingestHandoff,
    };
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
