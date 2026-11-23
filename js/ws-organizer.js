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
import { createZip } from './zip.js';
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

    function promptPasswordModal(filename) {
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

    async function renderSingleThumbnail(pdfDoc, pageIndexZeroBased, rotationDelta = 0) {
        const page = await pdfDoc.getPage(pageIndexZeroBased + 1);
        const totalRotation = ((page.rotate || 0) + rotationDelta) % 360;
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
        return canvas.toDataURL('image/jpeg', 0.85);
    }

    function createBlankThumbnail(rotationDelta = 0) {
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
        return canvas.toDataURL('image/png');
    }

    async function refreshThumbnailsForItems(items) {
        const byDoc = new Map();
        for (const item of items) {
            if (item.isBlankA4) {
                item.thumbnailDataUrl = createBlankThumbnail(item.rotationDelta);
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
                    item.thumbnailDataUrl = await renderSingleThumbnail(pdf, item.sourcePageIndex, item.rotationDelta);
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

    function renderGrid() {
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
                    ${item.rotationDelta ? `<span class="badge badge-neutral">${item.rotationDelta}°</span>` : ''}
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

            card.querySelector('.js-select').addEventListener('change', (e) => {
                item.selected = e.target.checked;
                card.classList.toggle('is-selected', item.selected);
                updateControls();
            });

            card.querySelector('.thumb-img-wrap').addEventListener('click', () => {
                item.selected = !item.selected;
                card.classList.toggle('is-selected', item.selected);
                card.querySelector('.js-select').checked = item.selected;
                updateControls();
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

            // Drag & drop reorder
            card.addEventListener('dragstart', (e) => {
                state.draggedIndex = index;
                card.classList.add('is-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(index));
            });
            card.addEventListener('dragend', () => {
                state.draggedIndex = null;
                card.classList.remove('is-dragging');
                grid.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
            });
            card.addEventListener('dragover', (e) => {
                if (state.draggedIndex === null || state.draggedIndex === index) return;
                e.preventDefault();
                card.classList.add('is-drop-target');
            });
            card.addEventListener('dragleave', () => {
                card.classList.remove('is-drop-target');
            });
            card.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                card.classList.remove('is-drop-target');
                if (state.draggedIndex === null || state.draggedIndex === index) return;
                const [moved] = state.pages.splice(state.draggedIndex, 1);
                state.pages.splice(index, 0, moved);
                state.draggedIndex = null;
                renderGrid();
            });

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
                const entered = await promptPasswordModal(name);
                if (!entered) {
                    toast(`Skipped "${name}" (password required).`, 'warn');
                    return;
                }
                unlockedBytes = await ensureUnlocked(rawBytes, entered);
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
                const thumb = await renderSingleThumbnail(pdf, i, 0);
                state.pages.push({
                    id: nextPageId++,
                    docId,
                    docName: name,
                    sourcePageIndex: i,
                    rotationDelta: 0,
                    thumbnailDataUrl: thumb,
                    isBlankA4: false,
                    selected: false,
                });
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
            thumbnailDataUrl: createBlankThumbnail(0),
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
