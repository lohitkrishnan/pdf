import { ensureUnlocked } from './qpdf-engine.js';
import {
    pdfjsLib,
    formatBytes,
    downloadBlob,
    readFileBytes,
    isPdfFile,
    stripPdfExtension,
} from './pdf-utils.js';
import { openPreviewModal } from './preview-modal.js';
import { createFillableNdaSample, createConfidentialEditableSample } from './samples.js';

// Field types that get a live HTML control on the page (see renderPageWidgets).
const OVERLAY_FIELD_TYPES = new Set(['text', 'checkbox', 'dropdown', 'optionlist', 'radio']);

const FONT_LABELS = {
    Helvetica: 'Sans (Helvetica)',
    TimesRoman: 'Serif (Times)',
    Courier: 'Mono (Courier)',
};

const COLOR_PRESETS = {
    black: '#1c1a17',
    blue: '#1d4ed8',
    red: '#b91c1c',
    green: '#15803d',
};

export function initEditorWorkspaces({
    root3,
    root4,
    sharedStageRoot,
    toast,
    switchToTab,
}) {
    const state = {
        activeTab: 'fill', // 'fill' | 'redact'
        tool: 'select',    // 'select' | 'text-edit' | 'text' | 'whiteout' | 'redaction'
        bytes: null,
        filename: '',
        pdfJsDoc: null,
        pagesMeta: [],     // [{ pageIndex, baseVp, canvas, textSpans, wrapperEl, overlayLayerEl, textLayerEl, widgetLayerEl }]
        formFields: [],    // [{ name, type, options, value }]
        formWidgetsByPage: new Map(), // pageIndex -> [{ fieldName, nx, ny, nw, nh }]
        formValues: {},
        flattenFields: false,
        burnInRedactions: true,
        overlays: [],      // overlay items
        selectedOverlayId: null,
        editingTextId: null,
        undoStack: [],
        redoStack: [],
        zoom: 1.05,
        busy: false,
        sigTab: 'draw',    // 'draw' | 'type' | 'upload'
        sigColor: '#181818',
        sigTypeStyle: 'cursive',
        sigUploadDataUrl: null,
        sigUploadRemoveWhite: true,
    };

    let nextOverlayId = 1;
    let renderSeq = 0;

    // Workspace 3 controls
    const fileInput3 = root3.querySelector('#ed3-file-input');
    const uploadBtn3 = root3.querySelector('#ed3-upload-btn');
    const sampleNdaBtn = root3.querySelector('#ed3-sample-btn');
    const formListEl = root3.querySelector('#ed3-form-list');
    const formCountBadge = root3.querySelector('#ed3-form-count');
    const flattenCb = root3.querySelector('#ed3-flatten-cb');

    const sigTabBtns = root3.querySelectorAll('.js-sig-tab');
    const sigDrawPane = root3.querySelector('#ed3-sig-draw-pane');
    const sigTypePane = root3.querySelector('#ed3-sig-type-pane');
    const sigUploadPane = root3.querySelector('#ed3-sig-upload-pane');
    const sigCanvas = root3.querySelector('#ed3-sig-pad');
    const sigClearBtn = root3.querySelector('#ed3-sig-clear');
    const sigPlaceDrawBtn = root3.querySelector('#ed3-sig-place-draw');
    const sigTypeInput = root3.querySelector('#ed3-sig-type-input');
    const sigTypePreview = root3.querySelector('#ed3-sig-type-preview');
    const sigPlaceTypeBtn = root3.querySelector('#ed3-sig-place-type');
    const sigUploadInput = root3.querySelector('#ed3-sig-upload-input');
    const sigRemoveWhiteCb = root3.querySelector('#ed3-sig-remove-white');
    const sigPlaceUploadBtn = root3.querySelector('#ed3-sig-place-upload');
    const sigColorBtns = root3.querySelectorAll('.js-sig-color');

    // Workspace 4 controls
    const fileInput4 = root4.querySelector('#ed4-file-input');
    const uploadBtn4 = root4.querySelector('#ed4-upload-btn');
    const sampleConfBtn = root4.querySelector('#ed4-sample-btn');
    const toolBtns = root4.querySelectorAll('.js-ed-tool');
    const verifiedStampBtn = root4.querySelector('#ed4-verified-btn');
    const addWhiteoutBtn = root4.querySelector('#ed4-add-whiteout-btn');
    const addRedactionBtn = root4.querySelector('#ed4-add-redaction-btn');
    const burnInCb = root4.querySelector('#ed4-burnin-cb');
    const undoBtn = root4.querySelector('#ed4-undo-btn');
    const redoBtn = root4.querySelector('#ed4-redo-btn');
    const clearOverlaysBtn = root4.querySelector('#ed4-clear-overlays-btn');
    const overlayListEl = root4.querySelector('#ed4-overlay-list');
    const overlayCountBadge = root4.querySelector('#ed4-overlay-count');

    // Inspector bar inside Workspace 4 sidebar
    const inspectorCard = root4.querySelector('#ed4-inspector');
    const inspTextInput = root4.querySelector('#ed4-insp-text');
    const inspFontSelect = root4.querySelector('#ed4-insp-font');
    const inspSizeInput = root4.querySelector('#ed4-insp-size');
    const inspBoldBtn = root4.querySelector('#ed4-insp-bold');
    const inspItalicBtn = root4.querySelector('#ed4-insp-italic');
    const inspColorSelect = root4.querySelector('#ed4-insp-color');
    const inspBgToggle = root4.querySelector('#ed4-insp-bg-toggle');
    const inspDeleteBtn = root4.querySelector('#ed4-insp-delete');

    // Shared Stage Header & Footer Export controls
    const stageDropzone = sharedStageRoot.querySelector('#ed-stage-empty');
    const stageFileInput = sharedStageRoot.querySelector('#ed-stage-file-input');
    const stagePagesEl = sharedStageRoot.querySelector('#ed-stage-pages');
    const stageScrollEl = sharedStageRoot.querySelector('#ed-stage-scroll');
    const docNameLabel = sharedStageRoot.querySelector('#ed-doc-name');
    const docMetaLabel = sharedStageRoot.querySelector('#ed-doc-meta');
    const zoomOutBtn = sharedStageRoot.querySelector('#ed-zoom-out');
    const zoomInBtn = sharedStageRoot.querySelector('#ed-zoom-in');
    const zoomLabel = sharedStageRoot.querySelector('#ed-zoom-label');
    const toolStatusPill = sharedStageRoot.querySelector('#ed-tool-status');
    const previewCompiledBtns = document.querySelectorAll('.js-ed-preview');
    const downloadCompiledBtns = document.querySelectorAll('.js-ed-download');

    // ---------- Undo / Redo Snapshots ----------

    function cloneOverlays(list) {
        return list.map((o) => ({ ...o }));
    }

    // Typing and size changes fire many events per edit; record one undo step per editing
    // session (same item + same kind of change) instead of none or one per keystroke.
    let undoCoalesceKey = null;
    function pushUndoCoalesced(key) {
        if (undoCoalesceKey === key) return;
        pushUndo();
        undoCoalesceKey = key;
    }

    function pushUndo() {
        undoCoalesceKey = null;
        state.undoStack.push(cloneOverlays(state.overlays));
        if (state.undoStack.length > 60) state.undoStack.shift();
        state.redoStack = [];
        updateActionButtons();
    }

    function undo() {
        if (state.undoStack.length === 0) return;
        undoCoalesceKey = null;
        state.redoStack.push(cloneOverlays(state.overlays));
        state.overlays = state.undoStack.pop();
        state.selectedOverlayId = null;
        state.editingTextId = null;
        renderAllPageOverlays();
        renderOverlaySidebar();
        renderInspector();
        updateActionButtons();
    }

    function redo() {
        if (state.redoStack.length === 0) return;
        undoCoalesceKey = null;
        state.undoStack.push(cloneOverlays(state.overlays));
        state.overlays = state.redoStack.pop();
        state.selectedOverlayId = null;
        state.editingTextId = null;
        renderAllPageOverlays();
        renderOverlaySidebar();
        renderInspector();
        updateActionButtons();
    }

    function updateActionButtons() {
        const hasDoc = Boolean(state.bytes);
        undoBtn.disabled = state.undoStack.length === 0 || state.busy;
        redoBtn.disabled = state.redoStack.length === 0 || state.busy;
        clearOverlaysBtn.disabled = state.overlays.length === 0 || state.busy;
        previewCompiledBtns.forEach((b) => { b.disabled = !hasDoc || state.busy; });
        downloadCompiledBtns.forEach((b) => { b.disabled = !hasDoc || state.busy; });
        zoomOutBtn.disabled = !hasDoc;
        zoomInBtn.disabled = !hasDoc;
    }

    // ---------- Password Prompt Helper ----------

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
                        <p class="muted-text">Enter open password for <strong>${escapeHtml(filename)}</strong>:</p>
                        <input type="password" class="input js-pw" placeholder="Open password" required autofocus />
                        <div class="modal-footer-btns">
                            <button type="button" class="btn btn-ghost btn-sm js-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary btn-sm">Unlock & Open</button>
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

    // ---------- Document Loading & AcroForm Inspection ----------

    async function loadPdfDocument({ name, bytes, password = '' }) {
        state.busy = true;
        updateActionButtons();

        try {
            let unlocked;
            try {
                unlocked = await ensureUnlocked(bytes, password);
            } catch (err) {
                if (err && (err.code === 'PASSWORD_REQUIRED' || err.code === 'INVALID_PASSWORD')) {
                    const entered = await promptPasswordModal(name);
                    if (!entered) {
                        toast('Cancelled opening password-protected PDF.', 'warn');
                        return;
                    }
                    unlocked = await ensureUnlocked(bytes, entered);
                } else {
                    throw err;
                }
            }

            if (state.pdfJsDoc) {
                try {
                    await state.pdfJsDoc.destroy();
                } catch {
                    // ignore
                }
                state.pdfJsDoc = null;
            }

            state.bytes = unlocked;
            state.filename = name || 'document.pdf';
            state.overlays = [];
            state.undoStack = [];
            state.redoStack = [];
            state.selectedOverlayId = null;
            state.editingTextId = null;
            state.formFields = [];
            state.formValues = {};
            state.formWidgetsByPage.clear();

            await inspectAcroForms(unlocked);
            state.pdfJsDoc = await pdfjsLib.getDocument({ data: unlocked.slice(0) }).promise;

            // Fit zoom to stage width initially
            const p1 = await state.pdfJsDoc.getPage(1);
            const vp1 = p1.getViewport({ scale: 1 });
            const availW = Math.max(360, (stageScrollEl.clientWidth || 720) - 56);
            state.zoom = Math.max(0.7, Math.min(1.25, Number((availW / vp1.width).toFixed(2))));

            docNameLabel.textContent = state.filename;
            docMetaLabel.textContent = `${state.pdfJsDoc.numPages} page${state.pdfJsDoc.numPages === 1 ? '' : 's'} · ${formatBytes(unlocked.byteLength)}`;
            stageDropzone.hidden = true;
            stagePagesEl.hidden = false;

            await renderStagePages();
            renderFormSidebar();
            renderOverlaySidebar();
            renderInspector();
            updateActionButtons();
        } catch (err) {
            toast(err?.message || 'Could not load PDF in editor.', 'error');
        } finally {
            state.busy = false;
            updateActionButtons();
        }
    }

    async function inspectAcroForms(pdfBytes) {
        const {
            PDFDocument,
            PDFTextField,
            PDFCheckBox,
            PDFDropdown,
            PDFOptionList,
            PDFRadioGroup,
        } = window.PDFLib;

        const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const form = doc.getForm();
        const fields = form.getFields();

        for (const field of fields) {
            const name = field.getName();
            if (field instanceof PDFTextField) {
                const val = field.getText() || '';
                let multiline = false;
                try { multiline = field.isMultiline(); } catch { /* ignore */ }
                state.formFields.push({ name, type: 'text', value: val, multiline });
                state.formValues[name] = val;
            } else if (field instanceof PDFCheckBox) {
                const val = field.isChecked();
                state.formFields.push({ name, type: 'checkbox', value: val });
                state.formValues[name] = val;
            } else if (field instanceof PDFDropdown) {
                const options = field.getOptions();
                const sel = field.getSelected();
                // An unselected dropdown stays blank; it must not silently become the first option.
                const val = sel && sel.length > 0 ? sel[0] : '';
                state.formFields.push({ name, type: 'dropdown', options, value: val });
                state.formValues[name] = val;
            } else if (field instanceof PDFOptionList) {
                const options = field.getOptions();
                const sel = field.getSelected();
                const val = sel && sel.length > 0 ? sel[0] : '';
                state.formFields.push({ name, type: 'optionlist', options, value: val });
                state.formValues[name] = val;
            } else if (field instanceof PDFRadioGroup) {
                const options = field.getOptions();
                const val = field.getSelected() || '';
                state.formFields.push({ name, type: 'radio', options, value: val });
                state.formValues[name] = val;
            }
        }
    }

    // ---------- PDF.js Text Span Extraction & Color/Font Sampling ----------

    // pdf.js only exposes a generic family ("sans-serif", "serif", "monospace") in text styles.
    // The real font name (e.g. "Helvetica-Bold", "ABCDEF+TimesNewRomanPSMT") lives on the font
    // object, which is available in page.commonObjs once the page has been rendered.
    function resolveRealFontName(page, loadedName) {
        try {
            if (page && loadedName && page.commonObjs.has(loadedName)) {
                const font = page.commonObjs.get(loadedName);
                return String(font?.name || font?.loadedName || '');
            }
        } catch {
            // font not resolved yet
        }
        return '';
    }

    function extractPageTextSpans(textContent, baseVp, page = null) {
        const rawItems = [];
        const styles = textContent.styles || {};
        const realNames = new Map();

        for (const item of textContent.items) {
            if (!item || typeof item.str !== 'string' || item.str.length === 0) continue;
            // Skip pure whitespace fragments unless needed between words
            const tx = pdfjsLib.Util.transform(baseVp.transform, item.transform);
            const baselineX = tx[4];
            const baselineY = tx[5];
            const fontSizePt = Math.max(6, Math.min(72, Math.hypot(item.transform[2], item.transform[3]) || item.height || 11));
            const height = Math.max(fontSizePt * 1.15, item.height || fontSizePt);
            const width = Math.max(2, item.width || fontSizePt * item.str.length * 0.45);
            const style = styles[item.fontName] || {};
            if (!realNames.has(item.fontName)) {
                realNames.set(item.fontName, resolveRealFontName(page, item.fontName));
            }

            rawItems.push({
                str: item.str,
                left: baselineX,
                right: baselineX + width,
                top: baselineY - height * 0.85,
                bottom: baselineY + height * 0.25,
                baselineY,
                fontSizePt,
                fontName: item.fontName || '',
                fontFamilyHint: `${item.fontName || ''} ${style.fontFamily || ''}`,
                fontRealName: realNames.get(item.fontName) || '',
                fontGeneric: style.fontFamily || '',
            });
        }

        // Merge adjacent items sitting on the same visual line with small horizontal gap
        const spans = [];
        for (const curr of rawItems) {
            if (!curr.str.trim()) continue;
            const prev = spans[spans.length - 1];
            const sameLine = prev && Math.abs(curr.baselineY - prev.baselineY) <= Math.max(curr.fontSizePt, prev.fontSizePt) * 0.35;
            const gap = prev ? curr.left - prev.right : Infinity;
            const closeGap = prev && gap >= -prev.fontSizePt * 0.5 && gap <= Math.max(curr.fontSizePt, prev.fontSizePt) * 1.35;

            if (sameLine && closeGap) {
                const needsSpace = gap > Math.max(curr.fontSizePt, prev.fontSizePt) * 0.22 && !prev.text.endsWith(' ') && !curr.str.startsWith(' ');
                prev.text += (needsSpace ? ' ' : '') + curr.str;
                prev.left = Math.min(prev.left, curr.left);
                prev.right = Math.max(prev.right, curr.right);
                prev.top = Math.min(prev.top, curr.top);
                prev.bottom = Math.max(prev.bottom, curr.bottom);
                prev.fontSizePt = Math.max(prev.fontSizePt, curr.fontSizePt);
            } else {
                spans.push({
                    text: curr.str,
                    left: curr.left,
                    right: curr.right,
                    top: curr.top,
                    bottom: curr.bottom,
                    baselineY: curr.baselineY,
                    fontSizePt: curr.fontSizePt,
                    fontFamilyHint: curr.fontFamilyHint,
                    fontRealName: curr.fontRealName,
                    fontGeneric: curr.fontGeneric,
                });
            }
        }

        return spans.map((s) => ({
            ...s,
            nx: clamp01(s.left / baseVp.width),
            ny: clamp01(s.top / baseVp.height),
            nw: clamp01((s.right - s.left) / baseVp.width),
            nh: clamp01((s.bottom - s.top) / baseVp.height),
        }));
    }

    function detectFontStyle(span) {
        const real = (span?.fontRealName || '').toLowerCase().replace(/^[a-z]{6}\+/, '');
        const generic = (span?.fontGeneric || '').toLowerCase();
        const hint = (span?.fontFamilyHint || '').toLowerCase();

        const MONO = /courier|mono|consolas|menlo|inconsolata/;
        const SERIF = /times|georgia|garamond|cambria|palatino|minion|book\s?antiqua|baskerville|lora|charter|serif/;
        const SANS = /helvetica|arial|sans|calibri|verdana|tahoma|segoe|roboto|inter|lato|gill|futura|frutiger|myriad|open\s?sans|source\s?sans/;

        const classify = (name) => {
            if (!name) return null;
            if (MONO.test(name)) return 'Courier';
            // Check sans before serif: "sans-serif" and "...Sans Serif" both contain "serif".
            if (SANS.test(name)) return 'Helvetica';
            if (SERIF.test(name)) return 'TimesRoman';
            return null;
        };

        // Prefer the real embedded font name, then pdf.js' generic family, then default to sans.
        const fontFamily = classify(real) || classify(generic) || 'Helvetica';
        const styleSource = `${real} ${hint}`;
        const bold = /bold|black|heavy|semibold|demi|[-_ ,](700|800|900)\b/.test(styleSource);
        const italic = /italic|oblique|slant/.test(styleSource);
        return { fontFamily, bold, italic };
    }

    function sampleCanvasRegionColors(canvas, nx, ny, nw, nh) {
        try {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const cw = canvas.width;
            const ch = canvas.height;
            const x = Math.max(0, Math.floor(nx * cw));
            const y = Math.max(0, Math.floor(ny * ch));
            const w = Math.max(2, Math.min(cw - x, Math.ceil(nw * cw)));
            const h = Math.max(2, Math.min(ch - y, Math.ceil(nh * ch)));

            // Sample 2px perimeter ring outside the text box for background color
            const pad = 3;
            const rx = Math.max(0, x - pad);
            const ry = Math.max(0, y - pad);
            const rw = Math.min(cw - rx, w + pad * 2);
            const rh = Math.min(ch - ry, h + pad * 2);
            const img = ctx.getImageData(rx, ry, rw, rh).data;

            const bgSamplesR = [];
            const bgSamplesG = [];
            const bgSamplesB = [];

            for (let py = 0; py < rh; py++) {
                for (let px = 0; px < rw; px++) {
                    const inRing = py < pad || py >= rh - pad || px < pad || px >= rw - pad;
                    if (!inRing) continue;
                    const idx = (py * rw + px) * 4;
                    bgSamplesR.push(img[idx]);
                    bgSamplesG.push(img[idx + 1]);
                    bgSamplesB.push(img[idx + 2]);
                }
            }

            const median = (arr) => {
                if (arr.length === 0) return 255;
                arr.sort((a, b) => a - b);
                return arr[Math.floor(arr.length / 2)];
            };

            const bgR = median(bgSamplesR);
            const bgG = median(bgSamplesG);
            const bgB = median(bgSamplesB);
            const maskColor = rgbToHex(bgR, bgG, bgB);

            // Sample highest-contrast pixels inside the text box for ink color
            let bestDist = 0;
            const fgR = [];
            const fgG = [];
            const fgB = [];

            for (let py = pad; py < rh - pad; py++) {
                for (let px = pad; px < rw - pad; px++) {
                    const idx = (py * rw + px) * 4;
                    const r = img[idx];
                    const g = img[idx + 1];
                    const b = img[idx + 2];
                    const dist = Math.hypot(r - bgR, g - bgG, b - bgB);
                    if (dist > 45) {
                        fgR.push(r);
                        fgG.push(g);
                        fgB.push(b);
                        if (dist > bestDist) bestDist = dist;
                    }
                }
            }

            let textColor = '#1c1a17';
            if (fgR.length > 0) {
                // Anti-aliased glyph edges are blends of ink and background, so a plain median
                // comes out lighter than the real ink. Use only the strongest-contrast pixels.
                const cutoff = bestDist * 0.8;
                const coreR = [];
                const coreG = [];
                const coreB = [];
                for (let k = 0; k < fgR.length; k++) {
                    if (Math.hypot(fgR[k] - bgR, fgG[k] - bgG, fgB[k] - bgB) >= cutoff) {
                        coreR.push(fgR[k]);
                        coreG.push(fgG[k]);
                        coreB.push(fgB[k]);
                    }
                }
                textColor = coreR.length > 0
                    ? rgbToHex(median(coreR), median(coreG), median(coreB))
                    : rgbToHex(median(fgR), median(fgG), median(fgB));
            }

            return { maskColor, textColor };
        } catch {
            return { maskColor: '#ffffff', textColor: '#1c1a17' };
        }
    }

    // ---------- Multi-Page Stage Rendering ----------

    async function renderStagePages() {
        if (!state.pdfJsDoc) return;
        const seq = ++renderSeq;
        stagePagesEl.innerHTML = '';
        state.pagesMeta = [];
        zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (let i = 0; i < state.pdfJsDoc.numPages; i++) {
            if (seq !== renderSeq) return;
            const page = await state.pdfJsDoc.getPage(i + 1);
            const baseVp = page.getViewport({ scale: 1 });
            const cssVp = page.getViewport({ scale: state.zoom });

            const pageCard = document.createElement('div');
            pageCard.className = 'ed-page-card';

            const pageHeader = document.createElement('div');
            pageHeader.className = 'ed-page-label';
            pageHeader.textContent = `Page ${i + 1} of ${state.pdfJsDoc.numPages}`;

            const wrapper = document.createElement('div');
            wrapper.className = 'pdf-page-wrapper';
            wrapper.dataset.pageIndex = String(i);
            wrapper.style.width = `${cssVp.width}px`;
            wrapper.style.height = `${cssVp.height}px`;

            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(cssVp.width * dpr));
            canvas.height = Math.max(1, Math.round(cssVp.height * dpr));
            canvas.style.width = `${cssVp.width}px`;
            canvas.style.height = `${cssVp.height}px`;

            const widgetLayer = document.createElement('div');
            widgetLayer.className = 'ed-widget-layer';

            const textLayer = document.createElement('div');
            textLayer.className = 'ed-text-edit-layer';

            const overlayLayer = document.createElement('div');
            overlayLayer.className = 'ed-overlay-layer';

            wrapper.append(canvas, widgetLayer, textLayer, overlayLayer);
            pageCard.append(pageHeader, wrapper);
            stagePagesEl.appendChild(pageCard);

            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Capture AcroForm widget rectangles for on-page interaction
            const annots = await page.getAnnotations();

            // Editable fields are drawn as live HTML inputs on top of the page. If pdf.js also
            // paints their saved appearance onto the canvas, every value shows up twice (and the
            // old value stays visible after editing). When every editable widget on this page has
            // an HTML overlay, render in forms mode so pdf.js leaves those widgets off the canvas.
            // Push buttons, signature fields and read-only fields are still painted normally.
            const overlayFieldNames = new Set(
                state.formFields.filter((f) => OVERLAY_FIELD_TYPES.has(f.type)).map((f) => f.name)
            );
            const editableWidgets = annots.filter(
                (a) => a.subtype === 'Widget' && !a.readOnly && !a.pushButton && a.fieldType !== 'Sig'
            );
            const canHideWidgets = editableWidgets.length > 0
                && editableWidgets.every((a) => a.fieldName && overlayFieldNames.has(a.fieldName));

            await page.render({
                canvasContext: ctx,
                viewport: cssVp,
                transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
                annotationMode: canHideWidgets ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE,
            }).promise;

            const textContent = await page.getTextContent();
            const textSpans = extractPageTextSpans(textContent, baseVp, page);

            const pageWidgets = [];
            for (const annot of annots) {
                if (annot.subtype !== 'Widget' || !annot.fieldName || !annot.rect) continue;
                const vpRect = baseVp.convertToViewportRectangle(annot.rect);
                const x1 = Math.min(vpRect[0], vpRect[2]);
                const y1 = Math.min(vpRect[1], vpRect[3]);
                const x2 = Math.max(vpRect[0], vpRect[2]);
                const y2 = Math.max(vpRect[1], vpRect[3]);
                pageWidgets.push({
                    fieldName: annot.fieldName,
                    nx: clamp01(x1 / baseVp.width),
                    ny: clamp01(y1 / baseVp.height),
                    nw: clamp01((x2 - x1) / baseVp.width),
                    nh: clamp01((y2 - y1) / baseVp.height),
                    buttonValue: annot.radioButton ? annot.buttonValue : undefined,
                });
            }
            state.formWidgetsByPage.set(i, pageWidgets);

            const meta = {
                pageIndex: i,
                baseVp,
                cssVp,
                rotate: page.rotate || 0,
                canvas,
                textSpans,
                wrapperEl: wrapper,
                widgetLayerEl: widgetLayer,
                textLayerEl: textLayer,
                overlayLayerEl: overlayLayer,
            };
            state.pagesMeta.push(meta);

            bindPageInteractions(meta);
            renderPageWidgets(meta);
            renderPageTextLayer(meta);
            renderPageOverlays(meta);
        }

        updateToolModeUI();
    }

    // ---------- Interactive On-Page Form Widgets (Synced with Workspace 3 Sidebar) ----------

    function renderPageWidgets(meta) {
        const layer = meta.widgetLayerEl;
        layer.innerHTML = '';
        const widgets = state.formWidgetsByPage.get(meta.pageIndex) || [];

        for (const w of widgets) {
            const field = state.formFields.find((f) => f.name === w.fieldName);
            if (!field) continue;

            const box = document.createElement('div');
            box.className = 'ed-widget-hotspot';
            box.style.left = `${w.nx * 100}%`;
            box.style.top = `${w.ny * 100}%`;
            box.style.width = `${w.nw * 100}%`;
            box.style.height = `${w.nh * 100}%`;
            box.title = `Form field: ${field.name}`;

            if (field.type === 'text') {
                const input = document.createElement(field.multiline ? 'textarea' : 'input');
                if (!field.multiline) input.type = 'text';
                input.className = field.multiline ? 'ed-widget-input ed-widget-textarea' : 'ed-widget-input';
                input.value = state.formValues[field.name] ?? '';
                input.dataset.field = field.name;
                input.addEventListener('input', (e) => {
                    state.formValues[field.name] = e.target.value;
                    syncFormSidebarField(field.name);
                    syncPageWidgetsForField(field.name);
                });
                box.appendChild(input);
            } else if (field.type === 'checkbox') {
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'ed-widget-checkbox';
                cb.checked = Boolean(state.formValues[field.name]);
                cb.dataset.field = field.name;
                cb.addEventListener('change', (e) => {
                    state.formValues[field.name] = e.target.checked;
                    syncFormSidebarField(field.name);
                });
                box.appendChild(cb);
            } else if (field.type === 'dropdown' || field.type === 'optionlist') {
                const sel = document.createElement('select');
                sel.className = 'ed-widget-select';
                sel.dataset.field = field.name;
                if (field.type !== 'radio') sel.appendChild(makeBlankOption(state.formValues[field.name]));
                for (const opt of field.options || []) {
                    const o = document.createElement('option');
                    o.value = opt;
                    o.textContent = opt;
                    if (opt === state.formValues[field.name]) o.selected = true;
                    sel.appendChild(o);
                }
                sel.addEventListener('change', (e) => {
                    state.formValues[field.name] = e.target.value;
                    syncFormSidebarField(field.name);
                });
                box.appendChild(sel);
            } else if (field.type === 'radio') {
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.className = 'ed-widget-checkbox ed-widget-radio';
                radio.name = `ed-radio-${meta.pageIndex}-${field.name}`;
                // pdf.js reports the widget's on-state name; when the field has an /Opt array that
                // name is often an index ("0", "1") while pdf-lib reports the option labels.
                let radioValue = w.buttonValue != null ? String(w.buttonValue) : '';
                const opts = field.options || [];
                if (!opts.includes(radioValue) && /^\d+$/.test(radioValue) && opts[Number(radioValue)] != null) {
                    radioValue = String(opts[Number(radioValue)]);
                }
                radio.value = radioValue;
                radio.checked = state.formValues[field.name] === radio.value;
                radio.dataset.field = field.name;
                radio.addEventListener('change', (e) => {
                    if (!e.target.checked) return;
                    state.formValues[field.name] = e.target.value;
                    syncFormSidebarField(field.name);
                    syncPageWidgetsForField(field.name);
                });
                box.appendChild(radio);
            }

            layer.appendChild(box);
        }
    }

    function syncFormSidebarField(fieldName) {
        const sidebarInput = formListEl.querySelector(`[data-sidebar-field="${CSS.escape(fieldName)}"]`);
        if (!sidebarInput) return;
        if (sidebarInput.type === 'checkbox') {
            sidebarInput.checked = Boolean(state.formValues[fieldName]);
        } else {
            sidebarInput.value = state.formValues[fieldName] ?? '';
        }
        updateFormCountBadge();
    }

    function syncPageWidgetsForField(fieldName) {
        for (const meta of state.pagesMeta) {
            const els = meta.widgetLayerEl.querySelectorAll(`[data-field="${CSS.escape(fieldName)}"]`);
            for (const el of els) {
                if (el.type === 'checkbox') {
                    el.checked = Boolean(state.formValues[fieldName]);
                } else if (el.type === 'radio') {
                    el.checked = state.formValues[fieldName] === el.value;
                } else if (el !== document.activeElement) {
                    el.value = state.formValues[fieldName] ?? '';
                }
            }
        }
        updateFormCountBadge();
    }

    function updateFormCountBadge() {
        const total = state.formFields.length;
        if (total === 0) {
            formCountBadge.textContent = '0 fields';
            return;
        }
        const filled = state.formFields.filter((f) => {
            const v = state.formValues[f.name];
            return typeof v === 'boolean' ? v : String(v || '').trim().length > 0;
        }).length;
        formCountBadge.textContent = `${filled}/${total} filled`;
    }

    function renderFormSidebar() {
        updateFormCountBadge();
        formListEl.innerHTML = '';

        if (!state.bytes) {
            formListEl.innerHTML = '<div class="empty-hint">Load a PDF or click <strong>Load Sample Fillable NDA</strong> to inspect interactive AcroForm fields.</div>';
            return;
        }

        if (state.formFields.length === 0) {
            formListEl.innerHTML = `
                <div class="empty-hint">
                    This PDF has no interactive AcroForm fields.<br/>
                    You can still fill flat PDFs using <strong>Edit PDF Text</strong> or <strong>Add Text</strong> in Workspace 4, and sign below!
                </div>
            `;
            return;
        }

        for (const field of state.formFields) {
            const row = document.createElement('div');
            row.className = 'form-field-row';

            const labelText = field.name.replace(/_/g, ' ');
            if (field.type === 'checkbox') {
                const label = document.createElement('label');
                label.className = 'checkbox-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = Boolean(state.formValues[field.name]);
                cb.dataset.sidebarField = field.name;
                cb.addEventListener('change', (e) => {
                    state.formValues[field.name] = e.target.checked;
                    syncPageWidgetsForField(field.name);
                });
                const span = document.createElement('span');
                span.textContent = labelText;
                label.append(cb, span);
                row.appendChild(label);
            } else if (field.type === 'dropdown' || field.type === 'optionlist' || field.type === 'radio') {
                const label = document.createElement('label');
                label.className = 'field-label';
                label.textContent = labelText;
                const sel = document.createElement('select');
                sel.className = 'input input-sm';
                sel.dataset.sidebarField = field.name;
                sel.appendChild(makeBlankOption(state.formValues[field.name]));
                for (const opt of field.options || []) {
                    const o = document.createElement('option');
                    o.value = opt;
                    o.textContent = opt;
                    if (opt === state.formValues[field.name]) o.selected = true;
                    sel.appendChild(o);
                }
                sel.addEventListener('change', (e) => {
                    state.formValues[field.name] = e.target.value;
                    syncPageWidgetsForField(field.name);
                });
                row.append(label, sel);
            } else {
                const label = document.createElement('label');
                label.className = 'field-label';
                label.textContent = labelText;
                const input = document.createElement(field.multiline ? 'textarea' : 'input');
                if (field.multiline) input.rows = 3;
                else input.type = 'text';
                input.className = 'input input-sm';
                input.value = state.formValues[field.name] ?? '';
                input.dataset.sidebarField = field.name;
                input.addEventListener('input', (e) => {
                    state.formValues[field.name] = e.target.value;
                    syncPageWidgetsForField(field.name);
                });
                row.append(label, input);
            }

            row.addEventListener('focusin', () => scrollToFieldWidget(field.name));
            formListEl.appendChild(row);
        }
    }

    function makeBlankOption(currentValue) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '— Select —';
        if (!currentValue) o.selected = true;
        return o;
    }

    function scrollToFieldWidget(fieldName) {
        for (const meta of state.pagesMeta) {
            const el = meta.widgetLayerEl.querySelector(`[data-field="${CSS.escape(fieldName)}"]`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
        }
    }

    // ---------- PDF.js Interactive Text-Edit Layer ----------

    function renderPageTextLayer(meta) {
        const layer = meta.textLayerEl;
        layer.innerHTML = '';

        meta.textSpans.forEach((span, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ed-pdf-text-span';
            btn.dataset.spanIndex = String(idx);
            btn.style.left = `${span.nx * 100}%`;
            btn.style.top = `${span.ny * 100}%`;
            btn.style.width = `${Math.max(span.nw * 100, 0.8)}%`;
            btn.style.height = `${Math.max(span.nh * 100, 1.2)}%`;
            btn.title = `Click to edit "${span.text}"`;
            btn.setAttribute('aria-label', `Edit PDF text: ${span.text}`);

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (state.tool !== 'text-edit') return;
                createOrFocusTextEditFromSpans(meta, [span]);
            });

            layer.appendChild(btn);
        });
    }

    function createOrFocusTextEditFromSpans(meta, spans) {
        if (!spans || spans.length === 0) return;

        // Union bounding box in normalized coordinates
        const minNx = Math.min(...spans.map((s) => s.nx));
        const minNy = Math.min(...spans.map((s) => s.ny));
        const maxNx = Math.max(...spans.map((s) => s.nx + s.nw));
        const maxNy = Math.max(...spans.map((s) => s.ny + s.nh));

        // Sort spans top-to-bottom, left-to-right to form natural text
        const sorted = [...spans].sort((a, b) => {
            if (Math.abs(a.baselineY - b.baselineY) > Math.max(a.fontSizePt, b.fontSizePt) * 0.4) {
                return a.baselineY - b.baselineY;
            }
            return a.left - b.left;
        });

        // Group into lines
        const lines = [];
        let currentLine = [];
        for (const sp of sorted) {
            const last = currentLine[currentLine.length - 1];
            if (!last || Math.abs(sp.baselineY - last.baselineY) <= Math.max(sp.fontSizePt, last.fontSizePt) * 0.4) {
                currentLine.push(sp);
            } else {
                lines.push(currentLine.map((x) => x.text).join(' '));
                currentLine = [sp];
            }
        }
        if (currentLine.length > 0) {
            lines.push(currentLine.map((x) => x.text).join(' '));
        }
        const combinedText = lines.join('\n');

        // Check if an existing text-edit already covers this exact span region
        const existing = state.overlays.find(
            (o) =>
                o.type === 'text-edit' &&
                o.pageIndex === meta.pageIndex &&
                Math.abs(o.origNx - minNx) < 0.008 &&
                Math.abs(o.origNy - minNy) < 0.008
        );
        if (existing) {
            state.selectedOverlayId = existing.id;
            state.editingTextId = existing.id;
            renderPageOverlays(meta);
            renderOverlaySidebar();
            renderInspector();
            return;
        }

        const nw = Math.max(0.06, maxNx - minNx + 0.015);
        const nh = Math.max(0.022, maxNy - minNy + 0.004);
        const { maskColor, textColor } = sampleCanvasRegionColors(meta.canvas, minNx, minNy, maxNx - minNx, maxNy - minNy);
        const { fontFamily, bold, italic } = detectFontStyle(sorted[0]);
        const fontSizePt = Math.max(8, Math.min(64, Math.round(sorted[0].fontSizePt)));

        pushUndo();
        const item = {
            id: nextOverlayId++,
            type: 'text-edit',
            pageIndex: meta.pageIndex,
            origNx: clamp01(minNx - 0.003),
            origNy: clamp01(minNy - 0.002),
            origNw: clamp01(maxNx - minNx + 0.008),
            origNh: clamp01(maxNy - minNy + 0.004),
            nx: clamp01(minNx - 0.003),
            ny: clamp01(minNy - 0.002),
            nw: clamp01(nw),
            nh: clamp01(nh),
            originalText: combinedText,
            text: combinedText,
            fontFamily,
            bold,
            italic,
            fontSizePt,
            color: textColor,
            matchedColor: textColor,
            maskColor,
            hasBg: true,
            // Distance from the top of the box to the first line's original baseline, so the
            // exported text lands on the same baseline as the text it replaces.
            baselineOffsetN: Math.max(0, sorted[0].baselineY / meta.baseVp.height - clamp01(minNy - 0.002)),
        };

        state.overlays.push(item);
        state.selectedOverlayId = item.id;
        state.editingTextId = item.id;
        renderPageOverlays(meta);
        renderOverlaySidebar();
        renderInspector();
    }

    // ---------- Canvas Drag / Draw / Marquee Interactions ----------

    function bindPageInteractions(meta) {
        const wrapper = meta.wrapperEl;

        wrapper.addEventListener('pointerdown', (e) => {
            // Only handle clicks directly on the page background or text-layer container (not existing overlay boxes or form widgets)
            if (e.target.closest('.ed-overlay-box') || e.target.closest('.ed-widget-hotspot')) return;
            if (e.target.closest('.ed-pdf-text-span') && state.tool === 'text-edit') return;

            if (state.tool === 'select') {
                if (state.selectedOverlayId !== null || state.editingTextId !== null) {
                    state.selectedOverlayId = null;
                    state.editingTextId = null;
                    renderAllPageOverlays();
                    renderOverlaySidebar();
                    renderInspector();
                }
                return;
            }

            const rect = wrapper.getBoundingClientRect();
            const startX = clamp01((e.clientX - rect.left) / rect.width);
            const startY = clamp01((e.clientY - rect.top) / rect.height);

            if (state.tool === 'text') {
                e.preventDefault();
                pushUndo();
                const item = {
                    id: nextOverlayId++,
                    type: 'text',
                    pageIndex: meta.pageIndex,
                    nx: clamp01(Math.min(startX, 0.72)),
                    ny: clamp01(Math.min(startY, 0.92)),
                    nw: 0.28,
                    nh: 0.055,
                    text: 'New annotation text',
                    fontFamily: 'Helvetica',
                    bold: false,
                    italic: false,
                    fontSizePt: 13,
                    color: COLOR_PRESETS.black,
                    maskColor: '#ffffff',
                    hasBg: false,
                };
                state.overlays.push(item);
                state.selectedOverlayId = item.id;
                state.editingTextId = item.id;
                renderPageOverlays(meta);
                renderOverlaySidebar();
                renderInspector();
                return;
            }

            if (state.tool === 'whiteout' || state.tool === 'redaction' || state.tool === 'text-edit') {
                e.preventDefault();
                const marquee = document.createElement('div');
                marquee.className = `ed-draw-marquee is-${state.tool}`;
                wrapper.appendChild(marquee);

                let curX = startX;
                let curY = startY;

                const updateMarquee = () => {
                    const x = Math.min(startX, curX);
                    const y = Math.min(startY, curY);
                    const w = Math.abs(curX - startX);
                    const h = Math.abs(curY - startY);
                    marquee.style.left = `${x * 100}%`;
                    marquee.style.top = `${y * 100}%`;
                    marquee.style.width = `${w * 100}%`;
                    marquee.style.height = `${h * 100}%`;
                };
                updateMarquee();

                const onMove = (ev) => {
                    curX = clamp01((ev.clientX - rect.left) / rect.width);
                    curY = clamp01((ev.clientY - rect.top) / rect.height);
                    updateMarquee();
                };

                const onUp = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    marquee.remove();

                    const nx = Math.min(startX, curX);
                    const ny = Math.min(startY, curY);
                    const nw = Math.abs(curX - startX);
                    const nh = Math.abs(curY - startY);

                    if (state.tool === 'text-edit') {
                        if (nw < 0.01 && nh < 0.01) return;
                        const matching = meta.textSpans.filter(
                            (sp) =>
                                sp.nx < nx + nw &&
                                sp.nx + sp.nw > nx &&
                                sp.ny < ny + nh &&
                                sp.ny + sp.nh > ny
                        );
                        if (matching.length > 0) {
                            createOrFocusTextEditFromSpans(meta, matching);
                        }
                        return;
                    }

                    // For click without drag, place a sensible default box
                    const finalW = nw > 0.02 ? nw : 0.24;
                    const finalH = nh > 0.015 ? nh : 0.045;
                    pushUndo();
                    const item = {
                        id: nextOverlayId++,
                        type: state.tool,
                        pageIndex: meta.pageIndex,
                        nx: clamp01(Math.min(nx, 1 - finalW)),
                        ny: clamp01(Math.min(ny, 1 - finalH)),
                        nw: clamp01(finalW),
                        nh: clamp01(finalH),
                    };
                    state.overlays.push(item);
                    state.selectedOverlayId = item.id;
                    renderPageOverlays(meta);
                    renderOverlaySidebar();
                    renderInspector();
                };

                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            }
        });
    }

    // ---------- Rendering Overlays + Drag & Resize ----------

    function renderAllPageOverlays() {
        for (const meta of state.pagesMeta) {
            renderPageOverlays(meta);
        }
    }

    function renderPageOverlays(meta) {
        const layer = meta.overlayLayerEl;
        layer.innerHTML = '';

        const items = state.overlays.filter((o) => o.pageIndex === meta.pageIndex);

        for (const item of items) {
            const box = document.createElement('div');
            const isSel = item.id === state.selectedOverlayId;
            const isEditing = item.id === state.editingTextId;
            box.className = `ed-overlay-box type-${item.type} ${isSel ? 'is-selected' : ''} ${isEditing ? 'is-editing' : ''}`;
            box.style.left = `${item.nx * 100}%`;
            box.style.top = `${item.ny * 100}%`;
            box.style.width = `${item.nw * 100}%`;
            box.style.height = `${item.nh * 100}%`;

            // Also render original mask footprint for text-edit if moved/resized smaller than original span
            if (item.type === 'text-edit') {
                const origMask = document.createElement('div');
                origMask.className = 'ed-orig-span-mask';
                origMask.style.left = `${item.origNx * 100}%`;
                origMask.style.top = `${item.origNy * 100}%`;
                origMask.style.width = `${item.origNw * 100}%`;
                origMask.style.height = `${item.origNh * 100}%`;
                origMask.style.backgroundColor = item.maskColor || '#ffffff';
                layer.appendChild(origMask);
            }

            if (item.type === 'text-edit' || item.type === 'text') {
                if (item.hasBg) {
                    box.style.backgroundColor = item.maskColor || '#ffffff';
                }
                const fontCss =
                    item.fontFamily === 'TimesRoman'
                        ? '"Times New Roman", Times, serif'
                        : item.fontFamily === 'Courier'
                            ? '"Courier New", Courier, monospace'
                            : 'Helvetica, Arial, sans-serif';

                if (isEditing) {
                    const ta = document.createElement('textarea');
                    ta.className = 'ed-inline-textarea';
                    ta.value = item.text;
                    ta.style.fontFamily = fontCss;
                    ta.style.fontSize = `${item.fontSizePt * state.zoom}px`;
                    ta.style.fontWeight = item.bold ? '700' : '400';
                    ta.style.fontStyle = item.italic ? 'italic' : 'normal';
                    ta.style.color = item.color;
                    ta.style.lineHeight = '1.2';

                    ta.addEventListener('pointerdown', (ev) => ev.stopPropagation());
                    ta.addEventListener('input', (ev) => {
                        pushUndoCoalesced(`text:${item.id}`);
                        item.text = ev.target.value;
                        if (state.selectedOverlayId === item.id) {
                            inspTextInput.value = item.text;
                        }
                        renderOverlaySidebar();
                    });
                    ta.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Escape') {
                            ev.stopPropagation();
                            state.editingTextId = null;
                            renderPageOverlays(meta);
                        }
                    });
                    box.appendChild(ta);
                    requestAnimationFrame(() => {
                        ta.focus();
                        ta.setSelectionRange(ta.value.length, ta.value.length);
                    });
                } else {
                    const preview = document.createElement('div');
                    preview.className = 'ed-inline-text-display';
                    preview.textContent = item.text;
                    preview.style.fontFamily = fontCss;
                    preview.style.fontSize = `${item.fontSizePt * state.zoom}px`;
                    preview.style.fontWeight = item.bold ? '700' : '400';
                    preview.style.fontStyle = item.italic ? 'italic' : 'normal';
                    preview.style.color = item.color;
                    preview.style.lineHeight = '1.2';
                    box.appendChild(preview);
                }

                box.addEventListener('dblclick', (ev) => {
                    ev.stopPropagation();
                    state.selectedOverlayId = item.id;
                    state.editingTextId = item.id;
                    renderPageOverlays(meta);
                    renderInspector();
                });
            } else if (item.type === 'verified') {
                box.innerHTML = `<div class="ed-verified-badge">${escapeHtml(item.text)}</div>`;
            } else if (item.type === 'signature') {
                const img = document.createElement('img');
                img.src = item.dataUrl;
                img.alt = item.label || 'Signature';
                img.className = 'ed-sig-img';
                img.draggable = false;
                box.appendChild(img);
            } else if (item.type === 'whiteout') {
                box.style.backgroundColor = '#ffffff';
            } else if (item.type === 'redaction') {
                box.innerHTML = '<span class="ed-redact-tag">REDACT</span>';
            }

            // Corner resize handle
            const resizeHandle = document.createElement('div');
            resizeHandle.className = 'ed-resize-handle';
            resizeHandle.title = 'Drag to resize';
            resizeHandle.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                startResizeOverlay(e, meta, item);
            });

            // Quick inline delete pill when selected
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'ed-box-delete';
            delBtn.textContent = '✕';
            delBtn.title = item.type === 'text-edit' ? 'Restore original PDF text' : 'Remove overlay';
            delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteOverlay(item.id);
            });

            box.append(resizeHandle, delBtn);

            box.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.ed-resize-handle') || e.target.closest('.ed-box-delete')) return;
                if (state.editingTextId === item.id && e.target.tagName === 'TEXTAREA') return;
                e.stopPropagation();

                // The first click re-renders the overlay layer, so the browser never sees two
                // clicks on the same element and 'dblclick' does not fire. Detect it here instead
                // (this also gives touch screens double-tap to edit).
                const now = performance.now();
                const isTextual = item.type === 'text-edit' || item.type === 'text';
                if (isTextual && lastOverlayPointerDown.id === item.id && now - lastOverlayPointerDown.t < 400) {
                    lastOverlayPointerDown = { id: null, t: 0 };
                    state.selectedOverlayId = item.id;
                    state.editingTextId = item.id;
                    renderPageOverlays(meta);
                    renderInspector();
                    renderOverlaySidebar();
                    return;
                }
                lastOverlayPointerDown = { id: item.id, t: now };

                state.selectedOverlayId = item.id;
                if (state.editingTextId !== item.id) {
                    state.editingTextId = null;
                }
                startDragOverlay(e, meta, item);
                renderInspector();
                renderOverlaySidebar();
            });

            layer.appendChild(box);
        }
    }

    let lastOverlayPointerDown = { id: null, t: 0 };

    function startDragOverlay(e, meta, item) {
        const rect = meta.wrapperEl.getBoundingClientRect();
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const origX = item.nx;
        const origY = item.ny;
        let moved = false;

        const onMove = (ev) => {
            const dx = (ev.clientX - startClientX) / rect.width;
            const dy = (ev.clientY - startClientY) / rect.height;
            if (!moved && (Math.abs(ev.clientX - startClientX) > 2 || Math.abs(ev.clientY - startClientY) > 2)) {
                pushUndo();
                moved = true;
            }
            if (moved) {
                item.nx = clamp01(Math.min(origX + dx, 1 - item.nw));
                item.ny = clamp01(Math.min(origY + dy, 1 - item.nh));
                renderPageOverlays(meta);
            }
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (!moved) {
                renderAllPageOverlays();
            }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }

    function startResizeOverlay(e, meta, item) {
        const rect = meta.wrapperEl.getBoundingClientRect();
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const origW = item.nw;
        const origH = item.nh;
        let resized = false;

        const onMove = (ev) => {
            const dw = (ev.clientX - startClientX) / rect.width;
            const dh = (ev.clientY - startClientY) / rect.height;
            if (!resized && (Math.abs(ev.clientX - startClientX) > 2 || Math.abs(ev.clientY - startClientY) > 2)) {
                pushUndo();
                resized = true;
            }
            if (resized) {
                item.nw = Math.max(0.03, Math.min(1 - item.nx, origW + dw));
                item.nh = Math.max(0.018, Math.min(1 - item.ny, origH + dh));
                renderPageOverlays(meta);
            }
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }

    function deleteOverlay(id) {
        pushUndo();
        state.overlays = state.overlays.filter((o) => o.id !== id);
        if (state.selectedOverlayId === id) state.selectedOverlayId = null;
        if (state.editingTextId === id) state.editingTextId = null;
        renderAllPageOverlays();
        renderOverlaySidebar();
        renderInspector();
    }

    // ---------- Inspector & Overlay Management Sidebar ----------

    function getSelectedOverlay() {
        return state.overlays.find((o) => o.id === state.selectedOverlayId) || null;
    }

    function renderInspector() {
        const item = getSelectedOverlay();
        const isTextual = item && (item.type === 'text-edit' || item.type === 'text');
        inspectorCard.hidden = !item;
        if (!item) return;

        root4.querySelector('#ed4-insp-title').textContent =
            item.type === 'text-edit' ? 'Edit Existing PDF Text'
                : item.type === 'text' ? 'Freeform Text Overlay'
                    : item.type === 'redaction' ? 'Confidential Redaction'
                        : item.type === 'whiteout' ? 'Whiteout Mask'
                            : item.type === 'verified' ? 'Verified Stamp'
                                : 'Signature / Image Stamp';

        root4.querySelector('#ed4-insp-text-controls').hidden = !isTextual;
        inspDeleteBtn.textContent = item.type === 'text-edit' ? 'Restore Original Text' : 'Delete Selected';

        if (isTextual) {
            inspTextInput.value = item.text;
            inspFontSelect.value = item.fontFamily;
            inspSizeInput.value = String(item.fontSizePt);
            inspBoldBtn.classList.toggle('is-active', Boolean(item.bold));
            inspItalicBtn.classList.toggle('is-active', Boolean(item.italic));
            const customOpt = inspColorSelect.querySelector('option[value="custom"]');
            if (customOpt) customOpt.disabled = !item.matchedColor;
            inspColorSelect.value = item.matchedColor && item.color === item.matchedColor
                ? 'custom'
                : findPresetOrCustom(item.color);
            inspBgToggle.checked = Boolean(item.hasBg);
        }
    }

    function findPresetOrCustom(hex) {
        const norm = (hex || '').toLowerCase();
        for (const val of Object.values(COLOR_PRESETS)) {
            if (val.toLowerCase() === norm) return val;
        }
        return 'custom';
    }

    function renderOverlaySidebar() {
        overlayCountBadge.textContent = String(state.overlays.length);
        overlayListEl.innerHTML = '';

        if (state.overlays.length === 0) {
            overlayListEl.innerHTML = '<div class="empty-hint">No edits or overlays placed yet.</div>';
            updateActionButtons();
            return;
        }

        const typeLabel = {
            'text-edit': 'Edited Text',
            text: 'Text Box',
            verified: 'Verified Stamp',
            whiteout: 'Whiteout',
            redaction: 'Redaction',
            signature: 'Signature',
        };

        for (const item of state.overlays) {
            const row = document.createElement('div');
            row.className = `overlay-item-row ${item.id === state.selectedOverlayId ? 'is-selected' : ''}`;
            const snippet = item.text ? item.text.replace(/\s+/g, ' ').slice(0, 28) : (item.label || '');

            row.innerHTML = `
                <button type="button" class="overlay-item-jump">
                    <span class="badge badge-neutral">p.${item.pageIndex + 1}</span>
                    <span class="overlay-item-type">${typeLabel[item.type] || item.type}</span>
                    ${snippet ? `<span class="overlay-item-snippet">${escapeHtml(snippet)}</span>` : ''}
                </button>
                <button type="button" class="btn btn-ghost btn-xs js-del" title="${item.type === 'text-edit' ? 'Restore original' : 'Remove'}">✕</button>
            `;

            row.querySelector('.overlay-item-jump').addEventListener('click', () => {
                state.selectedOverlayId = item.id;
                renderAllPageOverlays();
                renderOverlaySidebar();
                renderInspector();
                const meta = state.pagesMeta[item.pageIndex];
                if (meta) meta.wrapperEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });

            row.querySelector('.js-del').addEventListener('click', () => deleteOverlay(item.id));
            overlayListEl.appendChild(row);
        }

        updateActionButtons();
    }

    // ---------- Visible Page Helper for One-Click Stamps/Signatures ----------

    function getMostVisiblePageIndex() {
        if (state.pagesMeta.length === 0) return 0;
        const containerRect = stageScrollEl.getBoundingClientRect();
        const midY = containerRect.top + containerRect.height / 2;
        let bestIdx = 0;
        let bestDist = Infinity;

        for (const meta of state.pagesMeta) {
            const r = meta.wrapperEl.getBoundingClientRect();
            const centerY = r.top + r.height / 2;
            const d = Math.abs(centerY - midY);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = meta.pageIndex;
            }
        }
        return bestIdx;
    }

    function placeOverlayCenter({ type, nw, nh, aspect = null, extra = {} }) {
        if (!state.bytes || state.pagesMeta.length === 0) {
            toast('Open a PDF first before placing stamps or overlays.', 'warn');
            return;
        }
        const pageIndex = getMostVisiblePageIndex();
        const pageMeta = state.pagesMeta[pageIndex];
        if (aspect && pageMeta) {
            // Size from the actual page proportions (landscape, rotated, letter...), not a fixed A4 ratio.
            const pageRatio = pageMeta.baseVp.width / pageMeta.baseVp.height;
            nh = (nw * pageRatio) / aspect;
            if (nh > 0.4) {
                nw *= 0.4 / nh;
                nh = 0.4;
            }
        }
        pushUndo();
        const cascadeOffset = (state.overlays.length % 5) * 0.055;
        const item = {
            id: nextOverlayId++,
            type,
            pageIndex,
            nx: clamp01((1 - nw) / 2),
            ny: clamp01(Math.min(0.88 - nh, 0.40 + cascadeOffset)),
            nw,
            nh,
            ...extra,
        };
        state.overlays.push(item);
        state.selectedOverlayId = item.id;
        state.editingTextId = null;
        renderAllPageOverlays();
        renderOverlaySidebar();
        renderInspector();
        const meta = state.pagesMeta[pageIndex];
        if (meta) meta.wrapperEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // ---------- Signature Pad & Type/Upload Generators ----------

    function initSignaturePad() {
        const ctx = sigCanvas.getContext('2d');
        let drawing = false;
        let hasStrokes = false;
        let lastPt = null;

        const clearPad = () => {
            ctx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
            hasStrokes = false;
        };

        const getPt = (e) => {
            const r = sigCanvas.getBoundingClientRect();
            return {
                x: ((e.clientX - r.left) / r.width) * sigCanvas.width,
                y: ((e.clientY - r.top) / r.height) * sigCanvas.height,
            };
        };

        sigCanvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            sigCanvas.setPointerCapture(e.pointerId);
            drawing = true;
            hasStrokes = true;
            lastPt = getPt(e);
            ctx.beginPath();
            ctx.arc(lastPt.x, lastPt.y, 1.4, 0, Math.PI * 2);
            ctx.fillStyle = state.sigColor;
            ctx.fill();
        });

        sigCanvas.addEventListener('pointermove', (e) => {
            if (!drawing) return;
            const pt = getPt(e);
            ctx.strokeStyle = state.sigColor;
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(lastPt.x, lastPt.y);
            ctx.quadraticCurveTo(lastPt.x, lastPt.y, (lastPt.x + pt.x) / 2, (lastPt.y + pt.y) / 2);
            ctx.lineTo(pt.x, pt.y);
            ctx.stroke();
            lastPt = pt;
        });

        const stopDraw = () => { drawing = false; };
        sigCanvas.addEventListener('pointerup', stopDraw);
        sigCanvas.addEventListener('pointercancel', stopDraw);

        sigClearBtn.addEventListener('click', clearPad);

        sigPlaceDrawBtn.addEventListener('click', () => {
            if (!hasStrokes) {
                toast('Draw your signature in the pad first.', 'warn');
                return;
            }
            const cropped = cropTransparentCanvas(sigCanvas);
            const aspect = cropped.width / Math.max(1, cropped.height);
            const nw = Math.min(0.32, Math.max(0.14, aspect * 0.06));
            const nh = nw / aspect; // refined from the real page size in placeOverlayCenter
            placeOverlayCenter({
                type: 'signature',
                nw,
                nh,
                aspect,
                extra: { dataUrl: cropped.toDataURL('image/png'), label: 'Drawn Signature' },
            });
            toast('Placed drawn signature on page. Drag or resize to position.', 'ok');
        });
    }

    function renderTypedSignatureCanvas(text, style, color) {
        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 200;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const safeText = (text || 'Signature').trim() || 'Signature';
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (style === 'cursive') {
            ctx.font = 'italic 600 68px "Brush Script MT", "Segoe Script", "Apple Chancery", Georgia, serif';
            ctx.fillText(safeText, canvas.width / 2, canvas.height / 2);
        } else if (style === 'serif') {
            ctx.font = '600 54px "Lora", Georgia, "Times New Roman", serif';
            ctx.fillText(safeText, canvas.width / 2, canvas.height / 2);
        } else {
            // Official Stamp
            ctx.lineWidth = 5;
            ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
            ctx.lineWidth = 2;
            ctx.strokeRect(34, 34, canvas.width - 68, canvas.height - 68);
            ctx.font = '700 42px Helvetica, Arial, sans-serif';
            ctx.fillText(safeText.toUpperCase(), canvas.width / 2, canvas.height / 2);
        }

        return cropTransparentCanvas(canvas);
    }

    function updateTypePreview() {
        const cropped = renderTypedSignatureCanvas(sigTypeInput.value, state.sigTypeStyle, state.sigColor);
        sigTypePreview.src = cropped.toDataURL('image/png');
    }

    // ---------- Compilation Pipeline (AcroForm + Overlays + 200 DPI Burn-In Sanitization) ----------

    async function compileEditedPdf() {
        if (!state.bytes) throw new Error('No document loaded.');

        const {
            PDFDocument,
            StandardFonts,
            rgb,
            degrees,
            PDFTextField,
            PDFCheckBox,
            PDFDropdown,
            PDFOptionList,
            PDFRadioGroup,
        } = window.PDFLib;

        const pdfDoc = await PDFDocument.load(state.bytes, { ignoreEncryption: true });

        // Step A: Write AcroForm values & optionally flatten
        if (state.formFields.length > 0) {
            const form = pdfDoc.getForm();
            const unicodeFields = [];
            for (const f of state.formFields) {
                const val = state.formValues[f.name];
                try {
                    const fieldObj = form.getField(f.name);
                    if (fieldObj instanceof PDFTextField) {
                        fieldObj.setText(String(val ?? ''));
                        if (!isWinAnsiText(String(val ?? ''))) unicodeFields.push(fieldObj);
                    } else if (fieldObj instanceof PDFCheckBox) {
                        if (val) fieldObj.check();
                        else fieldObj.uncheck();
                    } else if (fieldObj instanceof PDFDropdown || fieldObj instanceof PDFOptionList) {
                        if (val) fieldObj.select(String(val));
                        else fieldObj.clear();
                    } else if (fieldObj instanceof PDFRadioGroup) {
                        if (val) fieldObj.select(String(val));
                        else fieldObj.clear();
                    }
                } catch {
                    // skip non-editable or unmapped fields gracefully
                }
            }
            if (unicodeFields.length > 0) {
                await applyUnicodeFieldAppearances(pdfDoc, unicodeFields);
            }
            if (state.flattenFields) {
                form.flatten();
            }
        }

        // Embed StandardFonts lazily on demand
        const embeddedFonts = new Map();
        const getStandardFont = async (family, bold, italic) => {
            let key = StandardFonts.Helvetica;
            if (family === 'TimesRoman') {
                if (bold && italic) key = StandardFonts.TimesRomanBoldItalic;
                else if (bold) key = StandardFonts.TimesRomanBold;
                else if (italic) key = StandardFonts.TimesRomanItalic;
                else key = StandardFonts.TimesRoman;
            } else if (family === 'Courier') {
                if (bold && italic) key = StandardFonts.CourierBoldOblique;
                else if (bold) key = StandardFonts.CourierBold;
                else if (italic) key = StandardFonts.CourierOblique;
                else key = StandardFonts.Courier;
            } else {
                if (bold && italic) key = StandardFonts.HelveticaBoldOblique;
                else if (bold) key = StandardFonts.HelveticaBold;
                else if (italic) key = StandardFonts.HelveticaOblique;
                else key = StandardFonts.Helvetica;
            }
            if (!embeddedFonts.has(key)) {
                embeddedFonts.set(key, await pdfDoc.embedFont(key));
            }
            return embeddedFonts.get(key);
        };

        const pages = pdfDoc.getPages();
        const redactionPages = new Set();

        for (const item of state.overlays) {
            const pdfPage = pages[item.pageIndex];
            const meta = state.pagesMeta[item.pageIndex];
            if (!pdfPage || !meta) continue;

            if (item.type === 'redaction') {
                redactionPages.add(item.pageIndex);
            }

            if (item.type === 'text-edit') {
                const origBox = viewportNormToPdfBox(meta.baseVp, item.origNx, item.origNy, item.origNw, item.origNh);
                const maskCol = hexToPdfRgb(item.maskColor || '#ffffff', rgb);
                pdfPage.drawRectangle({
                    x: origBox.x - 1,
                    y: origBox.y - 1,
                    width: origBox.width + 2,
                    height: origBox.height + 2,
                    color: maskCol,
                });
            }

            const box = viewportNormToPdfBox(meta.baseVp, item.nx, item.ny, item.nw, item.nh);

            if (item.type === 'whiteout') {
                pdfPage.drawRectangle({
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                    color: rgb(1, 1, 1),
                });
            } else if (item.type === 'redaction') {
                pdfPage.drawRectangle({
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                    color: rgb(0, 0, 0),
                });
            } else if (item.type === 'signature') {
                const pngBytes = dataUrlToUint8Array(item.dataUrl);
                const imgEmbed = await pdfDoc.embedPng(pngBytes);
                // Fit inside the box keeping the image's proportions, like object-fit: contain on screen.
                const v = visualRect(meta, item);
                const fit = Math.min(v.w / imgEmbed.width, v.h / imgEmbed.height);
                const fw = imgEmbed.width * fit;
                const fh = imgEmbed.height * fit;
                drawImageInVisualRect(pdfPage, meta, imgEmbed, v.x + (v.w - fw) / 2, v.y + (v.h - fh) / 2, fw, fh, degrees);
            } else if (item.type === 'verified') {
                const stampCanvas = renderVerifiedStampCanvas(item.text);
                const pngBytes = dataUrlToUint8Array(stampCanvas.toDataURL('image/png'));
                const imgEmbed = await pdfDoc.embedPng(pngBytes);
                const v = visualRect(meta, item);
                drawImageInVisualRect(pdfPage, meta, imgEmbed, v.x, v.y, v.w, v.h, degrees);
            } else if (item.type === 'text-edit' || item.type === 'text') {
                if (item.hasBg) {
                    pdfPage.drawRectangle({
                        x: box.x,
                        y: box.y,
                        width: box.width,
                        height: box.height,
                        color: hexToPdfRgb(item.maskColor || '#ffffff', rgb),
                    });
                }

                const content = item.text || '';
                if (content.trim().length > 0) {
                    const font = await getStandardFont(item.fontFamily, item.bold, item.italic);
                    await drawSafePdfText(pdfDoc, pdfPage, meta, visualRect(meta, item), {
                        text: content,
                        wrapAtPageEdge: item.type === 'text-edit',
                        font,
                        fontFamily: item.fontFamily,
                        bold: item.bold,
                        italic: item.italic,
                        size: item.fontSizePt,
                        baselineFromTop: item.baselineOffsetN != null ? item.baselineOffsetN * meta.baseVp.height : null,
                        colorHex: item.color || '#1c1a17',
                        rgbFn: rgb,
                        degreesFn: degrees,
                    });
                }
            }
        }

        let compiledBytes = new Uint8Array(await pdfDoc.save());

        // Step C: Burn-In Sanitization on redacted pages at 200 DPI JPEG (non-redacted pages remain 100% vector!)
        if (state.burnInRedactions && redactionPages.size > 0) {
            compiledBytes = await burnInRedactedPages(compiledBytes, redactionPages);
        }

        return compiledBytes;
    }

    // ---------- Unicode form field support (₹ and other characters outside WinAnsi) ----------

    // Characters the 14 standard PDF fonts can encode (WinAnsiEncoding).
    const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
    function isWinAnsiText(text) {
        for (const ch of text) {
            const c = ch.codePointAt(0);
            if (c === 9 || c === 10 || c === 13) continue;
            if (c >= 0x20 && c <= 0x7e) continue;
            if (c >= 0xa0 && c <= 0xff) continue;
            if (WINANSI_EXTRA.has(ch)) continue;
            return false;
        }
        return true;
    }

    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.onload = () => resolve();
            el.onerror = () => reject(new Error(`Could not load ${src}`));
            document.head.appendChild(el);
        });
    }

    // fontkit (~750 KB) and Noto Sans (~200 KB) are only fetched the first time a field needs them.
    let unicodeFontPromise = null;
    function loadUnicodeFont() {
        if (!unicodeFontPromise) {
            unicodeFontPromise = (async () => {
                if (!window.fontkit) await loadScriptOnce('./vendor/fontkit.umd.min.js');
                const res = await fetch('./vendor/fonts/NotoSans-Regular.ttf');
                if (!res.ok) throw new Error('Could not load the Unicode font.');
                return { fontkit: window.fontkit, bytes: new Uint8Array(await res.arrayBuffer()) };
            })().catch((err) => {
                unicodeFontPromise = null;
                throw err;
            });
        }
        return unicodeFontPromise;
    }

    // Text fields whose values the standard fonts can't encode (e.g. "₹") get appearances drawn
    // with an embedded, subset Noto Sans. Without this, pdf-lib throws "WinAnsi cannot encode"
    // when it generates appearances and the whole export fails.
    async function applyUnicodeFieldAppearances(pdfDoc, fields) {
        let font;
        try {
            const { fontkit, bytes } = await loadUnicodeFont();
            pdfDoc.registerFontkit(fontkit);
            // Embedded whole: pdf-lib's runtime subsetting drops glyphs from this font. The bundled
            // file is already trimmed to Latin, Greek, Cyrillic, punctuation and currency (~200 KB).
            font = await pdfDoc.embedFont(bytes, { subset: false });
        } catch {
            // Offline or blocked: keep the export working with ASCII stand-ins.
            for (const field of fields) {
                const safe = [...(field.getText() || '')]
                    .map((ch) => (ch === '₹' ? 'Rs.' : isWinAnsiText(ch) ? ch : '?'))
                    .join('');
                field.setText(safe);
            }
            toast('Could not load the Unicode font, so ₹ was written as "Rs." and other unsupported characters as "?".', 'warn');
            return;
        }

        const supported = new Set(font.getCharacterSet());
        const missing = new Set();
        for (const field of fields) {
            for (const ch of field.getText() || '') {
                if (!/\s/.test(ch) && !supported.has(ch.codePointAt(0))) missing.add(ch);
            }
            field.updateAppearances(font);
        }
        if (missing.size > 0) {
            toast(`These characters aren't supported in form fields and may not display: ${[...missing].join(' ')}`, 'warn');
        }
    }

    /**
     * Produce a sanitized copy of `bytes` in which every page in `redactionPages` exists only
     * as a flat 200 DPI image. Nothing from the original redacted pages may survive in the file:
     *
     *  - pdf-lib's removePage()/save() keeps unreferenced objects, so the old content streams
     *    would still be inside the file. Instead, all pages are copied into a brand-new document;
     *    the copier only brings across objects that are still reachable.
     *  - Before copying, each redacted page is stripped in place (no contents, resources,
     *    annotations or inherited attributes), so links or annotations on other pages that point
     *    at it cannot drag its old content back in.
     *  - Form fields are flattened first: a field's dictionary links all of its widgets, so a field
     *    shared with a redacted page could otherwise carry that page's values across.
     *  - The new document has no Info dictionary, XMP metadata, outlines, named destinations,
     *    attachments or JavaScript, since none of those are copied from the catalog.
     */
    async function burnInRedactedPages(bytes, redactionPages) {
        const { PDFDocument, PDFName, PDFDict, PDFArray } = window.PDFLib;
        const redacted = Array.from(redactionPages).sort((a, b) => a - b);

        // 1. Rasterize the redacted pages exactly as they look in the compiled file.
        const rasters = new Map();
        const jsDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
        try {
            for (const pageIdx of redacted) {
                const jsPage = await jsDoc.getPage(pageIdx + 1);
                const baseVp = jsPage.getViewport({ scale: 1 });
                const renderVp = jsPage.getViewport({ scale: 200 / 72 });
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(renderVp.width));
                canvas.height = Math.max(1, Math.round(renderVp.height));
                const ctx = canvas.getContext('2d', { alpha: false });
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await jsPage.render({ canvasContext: ctx, viewport: renderVp }).promise;
                rasters.set(pageIdx, {
                    jpg: dataUrlToUint8Array(canvas.toDataURL('image/jpeg', 0.9)),
                    width: baseVp.width,
                    height: baseVp.height,
                });
                canvas.width = 0;
                canvas.height = 0;
            }
        } finally {
            await jsDoc.destroy();
        }

        const src = await PDFDocument.load(bytes);

        // 2. Flatten form fields so no field dictionary links pages together.
        try {
            const form = src.getForm();
            if (form.getFields().length > 0) form.flatten();
        } catch {
            // Flattening failed: drop the form and every widget annotation instead.
            src.catalog.delete(PDFName.of('AcroForm'));
            for (const page of src.getPages()) {
                const annots = page.node.lookup(PDFName.of('Annots'));
                if (!(annots instanceof PDFArray)) continue;
                const keep = [];
                for (let i = 0; i < annots.size(); i++) {
                    const a = annots.lookup(i);
                    if (a instanceof PDFDict && a.get(PDFName.of('Subtype'))?.toString() === '/Widget') continue;
                    keep.push(annots.get(i));
                }
                page.node.set(PDFName.of('Annots'), src.context.obj(keep));
            }
        }

        // 3. Strip the redacted pages in place, and cut annotation back-references between pages.
        const srcPages = src.getPages();
        srcPages.forEach((page, idx) => {
            const node = page.node;
            if (rasters.has(idx)) {
                const { width, height } = rasters.get(idx);
                for (const key of node.keys()) {
                    const k = key.toString();
                    if (k !== '/Type' && k !== '/Parent') node.delete(key);
                }
                // Set inheritable attributes explicitly so the copier cannot pull them from the tree.
                node.set(PDFName.of('MediaBox'), src.context.obj([0, 0, width, height]));
                node.set(PDFName.of('CropBox'), src.context.obj([0, 0, width, height]));
                node.set(PDFName.of('Rotate'), src.context.obj(0));
                node.set(PDFName.of('Resources'), src.context.obj({}));
                return;
            }
            node.delete(PDFName.of('Metadata'));
            node.delete(PDFName.of('PieceInfo'));
            const annots = node.lookup(PDFName.of('Annots'));
            if (annots instanceof PDFArray) {
                for (let i = 0; i < annots.size(); i++) {
                    const a = annots.lookup(i);
                    if (a instanceof PDFDict) {
                        a.delete(PDFName.of('P'));
                        a.delete(PDFName.of('IRT'));
                    }
                }
            }
        });

        // 4. Copy everything that is still reachable into a fresh document (no Info/XMP).
        const fresh = await PDFDocument.create({ updateMetadata: false });
        const copied = await fresh.copyPages(src, srcPages.map((_, i) => i));
        for (let i = 0; i < copied.length; i++) {
            const page = fresh.addPage(copied[i]);
            const raster = rasters.get(i);
            if (raster) {
                const img = await fresh.embedJpg(raster.jpg);
                page.drawImage(img, { x: 0, y: 0, width: raster.width, height: raster.height });
            }
        }

        return new Uint8Array(await fresh.save());
    }

    // Overlay geometry is stored normalized to the page as it appears on screen (pdf.js viewport,
    // which already includes the page's /Rotate). These helpers work in that visual space and map
    // anchor points into PDF user space, drawing with the page rotation so the result looks upright.
    function visualRect(meta, item) {
        return {
            x: item.nx * meta.baseVp.width,
            y: item.ny * meta.baseVp.height,
            w: item.nw * meta.baseVp.width,
            h: item.nh * meta.baseVp.height,
        };
    }

    function pageRotation(meta) {
        return ((meta.baseVp.rotation % 360) + 360) % 360;
    }

    function drawImageInVisualRect(pdfPage, meta, img, vx, vy, vw, vh, degreesFn) {
        // The image's own bottom-left corner goes at the visual bottom-left of the rect.
        const [x, y] = meta.baseVp.convertToPdfPoint(vx, vy + vh);
        pdfPage.drawImage(img, { x, y, width: vw, height: vh, rotate: degreesFn(pageRotation(meta)) });
    }

    // Greedy word wrap matching the on-screen box (white-space: pre-wrap; word-break: break-word).
    function wrapTextLines(text, measure, maxWidth) {
        const out = [];
        for (const para of String(text).split(/\r?\n/)) {
            let line = '';
            for (const word of para.split(/(?<=\s)/)) {
                if (measure((line + word).trimEnd()) <= maxWidth) {
                    line += word;
                    continue;
                }
                if (line.trim()) {
                    out.push(line.trimEnd());
                    line = '';
                }
                // A single word wider than the box is broken by characters.
                let chunk = '';
                for (const ch of word) {
                    if (chunk && measure((chunk + ch).trimEnd()) > maxWidth) {
                        out.push(chunk);
                        chunk = '';
                    }
                    chunk += ch;
                }
                line = chunk;
            }
            out.push(line.trimEnd());
        }
        return out;
    }

    async function drawSafePdfText(pdfDoc, pdfPage, meta, v, opts) {
        const lineHeight = opts.size * 1.2;
        const baselineFromTop = opts.baselineFromTop ?? opts.size * 0.85;
        const padX = 1;
        // Freeform text boxes wrap at their own width. Boxes for edited PDF text are sized tightly to
        // the original words, so replacement text keeps to one line and only wraps at the page edge.
        const maxWidth = opts.wrapAtPageEdge
            ? Math.max(4, meta.baseVp.width - v.x - padX - 4)
            : Math.max(4, v.w - 2 * padX - 2);
        const rotate = opts.degreesFn(pageRotation(meta));

        // Vector text when every character encodes in the standard font's WinAnsi encoding.
        let lines = null;
        try {
            lines = wrapTextLines(opts.text, (t) => opts.font.widthOfTextAtSize(t, opts.size), maxWidth);
            for (const line of lines) opts.font.encodeText(line);
        } catch {
            lines = null;
        }

        if (lines) {
            const pdfColor = hexToPdfRgb(opts.colorHex, opts.rgbFn);
            lines.forEach((line, idx) => {
                if (!line) return;
                const [x, y] = meta.baseVp.convertToPdfPoint(v.x + padX, v.y + baselineFromTop + idx * lineHeight);
                pdfPage.drawText(line, { x, y, size: opts.size, font: opts.font, color: pdfColor, rotate });
            });
            return;
        }

        // High-DPI transparent PNG fallback for characters the standard fonts can't encode (e.g. ✓, ₹)
        const fontCss =
            opts.fontFamily === 'TimesRoman'
                ? '"Times New Roman", Times, serif'
                : opts.fontFamily === 'Courier'
                    ? '"Courier New", Courier, monospace'
                    : 'Helvetica, Arial, sans-serif';
        const cssFont = `${opts.italic ? 'italic ' : ''}${opts.bold ? '700 ' : '400 '}${opts.size}px ${fontCss}`;

        const measureCtx = document.createElement('canvas').getContext('2d');
        measureCtx.font = cssFont;
        const pngLines = wrapTextLines(opts.text, (t) => measureCtx.measureText(t).width, maxWidth);
        // The image is at least the box, and wider/taller if the text needs it (edited lines may
        // run past their original box, exactly as the vector path draws them).
        const longest = Math.max(0, ...pngLines.map((t) => measureCtx.measureText(t).width));
        const drawW = Math.max(v.w, Math.min(longest + 2 * padX + 1, meta.baseVp.width - v.x));
        const drawH = Math.max(v.h, baselineFromTop + (pngLines.length - 1) * lineHeight + opts.size * 0.3);

        const scale = 4;
        const c = document.createElement('canvas');
        c.width = Math.max(4, Math.ceil(drawW * scale));
        c.height = Math.max(4, Math.ceil(drawH * scale));
        const ctx = c.getContext('2d');
        ctx.scale(scale, scale);
        ctx.font = cssFont;
        ctx.fillStyle = opts.colorHex;
        ctx.textBaseline = 'alphabetic';
        pngLines.forEach((line, idx) => {
            ctx.fillText(line, padX, baselineFromTop + idx * lineHeight);
        });

        const pngBytes = dataUrlToUint8Array(c.toDataURL('image/png'));
        const embed = await pdfDoc.embedPng(pngBytes);
        drawImageInVisualRect(pdfPage, meta, embed, v.x, v.y, drawW, drawH, opts.degreesFn);
    }

    function renderVerifiedStampCanvas(text) {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 128;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);

        ctx.fillStyle = 'rgba(21, 128, 61, 0.08)';
        ctx.strokeStyle = '#15803d';
        ctx.lineWidth = 6;
        roundRect(ctx, 8, 8, c.width - 16, c.height - 16, 16);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#15803d';
        ctx.font = '700 38px Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, c.width / 2, c.height / 2 + 2);
        return c;
    }

    // ---------- Tool Mode & UI Binding ----------

    function updateToolModeUI() {
        toolBtns.forEach((b) => {
            b.classList.toggle('is-active', b.dataset.tool === state.tool);
        });

        const showTextSpans = state.activeTab === 'redact' && state.tool === 'text-edit';
        const allowWidgetInteraction = state.activeTab === 'fill' && state.tool === 'select';

        sharedStageRoot.classList.toggle('mode-text-edit', showTextSpans);
        sharedStageRoot.classList.toggle('mode-draw-box', state.activeTab === 'redact' && (state.tool === 'whiteout' || state.tool === 'redaction' || state.tool === 'text'));
        sharedStageRoot.classList.toggle('mode-widgets-active', allowWidgetInteraction);

        const descriptions = {
            select: 'Select & move signatures or overlays',
            'text-edit': 'Click any highlighted text span (or drag across words) to edit PDF text inline',
            text: 'Click anywhere on a page to place a freeform text box',
            whiteout: 'Click & drag on a page to cover unwanted regions with whiteout',
            redaction: 'Click & drag to mark Confidential Redactions (200 DPI burn-in ON)',
        };
        toolStatusPill.textContent = descriptions[state.tool] || '';
    }

    function setTab(tabName) {
        state.activeTab = tabName;
        if (tabName === 'fill') {
            state.tool = 'select';
        }
        updateToolModeUI();
    }

    // File ingestion bindings
    const handleInputChange = async (fileList) => {
        const file = Array.from(fileList || []).find(isPdfFile);
        if (!file) {
            toast('Please select a .pdf file.', 'warn');
            return;
        }
        const bytes = await readFileBytes(file);
        await loadPdfDocument({ name: file.name, bytes });
    };

    uploadBtn3.addEventListener('click', () => fileInput3.click());
    fileInput3.addEventListener('change', (e) => { handleInputChange(e.target.files); fileInput3.value = ''; });
    uploadBtn4.addEventListener('click', () => fileInput4.click());
    fileInput4.addEventListener('change', (e) => { handleInputChange(e.target.files); fileInput4.value = ''; });

    stageDropzone.addEventListener('click', () => stageFileInput.click());
    stageDropzone.addEventListener('dragover', (e) => { e.preventDefault(); stageDropzone.classList.add('is-dragover'); });
    stageDropzone.addEventListener('dragleave', () => stageDropzone.classList.remove('is-dragover'));
    stageDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        stageDropzone.classList.remove('is-dragover');
        handleInputChange(e.dataTransfer.files);
    });
    stageFileInput.addEventListener('change', (e) => { handleInputChange(e.target.files); stageFileInput.value = ''; });

    sampleNdaBtn.addEventListener('click', async () => {
        sampleNdaBtn.disabled = true;
        sampleNdaBtn.textContent = 'Generating NDA…';
        try {
            const sample = await createFillableNdaSample();
            await loadPdfDocument(sample);
            toast('Loaded sample fillable Mutual NDA (AcroForm fields + signature page).', 'ok');
        } finally {
            sampleNdaBtn.disabled = false;
            sampleNdaBtn.textContent = 'Load Sample Fillable NDA';
        }
    });

    sampleConfBtn.addEventListener('click', async () => {
        sampleConfBtn.disabled = true;
        sampleConfBtn.textContent = 'Generating sample…';
        try {
            const sample = await createConfidentialEditableSample();
            await loadPdfDocument(sample);
            state.tool = 'text-edit';
            updateToolModeUI();
            toast('Loaded sample Confidential Invoice. Click any text to edit inline, or drag to redact.', 'ok');
        } finally {
            sampleConfBtn.disabled = false;
            sampleConfBtn.textContent = 'Load Sample Confidential PDF';
        }
    });

    flattenCb.addEventListener('change', (e) => { state.flattenFields = e.target.checked; });
    burnInCb.addEventListener('change', (e) => { state.burnInRedactions = e.target.checked; });

    // Signature studio events
    sigTabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            state.sigTab = btn.dataset.sigTab;
            sigTabBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
            sigDrawPane.hidden = state.sigTab !== 'draw';
            sigTypePane.hidden = state.sigTab !== 'type';
            sigUploadPane.hidden = state.sigTab !== 'upload';
        });
    });

    sigColorBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            state.sigColor = btn.dataset.color;
            sigColorBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
            updateTypePreview();
        });
    });

    root3.querySelectorAll('input[name="ed3-sig-style"]').forEach((r) => {
        r.addEventListener('change', (e) => {
            if (!e.target.checked) return;
            state.sigTypeStyle = e.target.value;
            updateTypePreview();
        });
    });

    sigTypeInput.addEventListener('input', updateTypePreview);
    sigPlaceTypeBtn.addEventListener('click', () => {
        const text = sigTypeInput.value.trim();
        if (!text) {
            toast('Type your name or stamp label first.', 'warn');
            sigTypeInput.focus();
            return;
        }
        const cropped = renderTypedSignatureCanvas(text, state.sigTypeStyle, state.sigColor);
        const aspect = cropped.width / Math.max(1, cropped.height);
        const nw = Math.min(0.35, Math.max(0.16, aspect * 0.055));
        const nh = nw / aspect; // refined from the real page size in placeOverlayCenter
        placeOverlayCenter({
            type: 'signature',
            nw,
            nh,
            aspect,
            extra: { dataUrl: cropped.toDataURL('image/png'), label: `Typed: ${text}` },
        });
        toast('Placed typed signature on page.', 'ok');
    });

    sigUploadInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        state.sigUploadDataUrl = await processUploadedStamp(file, sigRemoveWhiteCb.checked);
        sigPlaceUploadBtn.disabled = false;
        toast(`Stamp image "${file.name}" ready. Click Place Image Stamp.`, 'ok');
    });
    sigRemoveWhiteCb.addEventListener('change', () => {
        state.sigUploadRemoveWhite = sigRemoveWhiteCb.checked;
    });
    sigPlaceUploadBtn.addEventListener('click', async () => {
        const file = sigUploadInput.files?.[0];
        let dataUrl = state.sigUploadDataUrl;
        if (file) {
            dataUrl = await processUploadedStamp(file, sigRemoveWhiteCb.checked);
        }
        if (!dataUrl) {
            toast('Upload a .png, .jpg, or .webp signature/stamp image first.', 'warn');
            return;
        }
        const img = await loadImageFromUrl(dataUrl);
        const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
        const nw = 0.24;
        const nh = nw / aspect; // refined from the real page size in placeOverlayCenter
        placeOverlayCenter({
            type: 'signature',
            nw,
            nh,
            aspect,
            extra: { dataUrl, label: 'Image Stamp' },
        });
    });

    // Workspace 4 tools & quick buttons
    toolBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            state.tool = btn.dataset.tool;
            updateToolModeUI();
        });
    });

    verifiedStampBtn.addEventListener('click', () => {
        const today = new Date().toISOString().slice(0, 10);
        placeOverlayCenter({
            type: 'verified',
            nw: 0.30,
            nh: 0.045,
            extra: { text: `✓ Verified (${today})`, label: `Verified (${today})` },
        });
    });

    addWhiteoutBtn.addEventListener('click', () => {
        placeOverlayCenter({ type: 'whiteout', nw: 0.25, nh: 0.045 });
    });

    addRedactionBtn.addEventListener('click', () => {
        placeOverlayCenter({ type: 'redaction', nw: 0.28, nh: 0.045 });
    });

    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
    clearOverlaysBtn.addEventListener('click', () => {
        if (state.overlays.length === 0) return;
        pushUndo();
        state.overlays = [];
        state.selectedOverlayId = null;
        state.editingTextId = null;
        renderAllPageOverlays();
        renderOverlaySidebar();
        renderInspector();
    });

    // Inspector live bindings
    inspTextInput.addEventListener('input', (e) => {
        const item = getSelectedOverlay();
        if (!item) return;
        pushUndoCoalesced(`text:${item.id}`);
        item.text = e.target.value;
        const meta = state.pagesMeta[item.pageIndex];
        if (meta) {
            const ta = meta.overlayLayerEl.querySelector('.ed-overlay-box.is-selected textarea');
            const disp = meta.overlayLayerEl.querySelector('.ed-overlay-box.is-selected .ed-inline-text-display');
            if (ta) ta.value = item.text;
            if (disp) disp.textContent = item.text;
        }
        renderOverlaySidebar();
    });
    inspFontSelect.addEventListener('change', (e) => {
        const item = getSelectedOverlay();
        if (!item) return;
        pushUndo();
        item.fontFamily = e.target.value;
        renderAllPageOverlays();
    });
    inspSizeInput.addEventListener('input', (e) => {
        const item = getSelectedOverlay();
        if (!item) return;
        pushUndoCoalesced(`size:${item.id}`);
        item.fontSizePt = Math.max(8, Math.min(64, Number(e.target.value) || 12));
        renderAllPageOverlays();
    });
    inspBoldBtn.addEventListener('click', () => {
        const item = getSelectedOverlay();
        if (!item) return;
        pushUndo();
        item.bold = !item.bold;
        renderInspector();
        renderAllPageOverlays();
    });
    inspItalicBtn.addEventListener('click', () => {
        const item = getSelectedOverlay();
        if (!item) return;
        pushUndo();
        item.italic = !item.italic;
        renderInspector();
        renderAllPageOverlays();
    });
    inspColorSelect.addEventListener('change', (e) => {
        const item = getSelectedOverlay();
        if (!item) return;
        if (e.target.value === 'custom') {
            // "Matched Color" restores the ink colour sampled from the original PDF text.
            if (!item.matchedColor || item.matchedColor === item.color) return;
            pushUndo();
            item.color = item.matchedColor;
        } else {
            pushUndo();
            item.color = e.target.value;
        }
        renderAllPageOverlays();
    });
    inspBgToggle.addEventListener('change', (e) => {
        const item = getSelectedOverlay();
        if (!item) return;
        pushUndo();
        item.hasBg = e.target.checked;
        renderAllPageOverlays();
    });
    inspDeleteBtn.addEventListener('click', () => {
        const item = getSelectedOverlay();
        if (item) deleteOverlay(item.id);
    });

    // Zoom controls
    zoomOutBtn.addEventListener('click', () => {
        if (!state.bytes) return;
        state.zoom = Math.max(0.55, Number((state.zoom - 0.15).toFixed(2)));
        renderStagePages();
    });
    zoomInBtn.addEventListener('click', () => {
        if (!state.bytes) return;
        state.zoom = Math.min(2.2, Number((state.zoom + 0.15).toFixed(2)));
        renderStagePages();
    });

    // Export / Preview buttons (shared across Workspace 3 & Workspace 4)
    previewCompiledBtns.forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!state.bytes || state.busy) return;
            state.busy = true;
            updateActionButtons();
            try {
                const compiled = await compileEditedPdf();
                const outName = `${stripPdfExtension(state.filename)}_edited.pdf`;
                await openPreviewModal({ bytes: compiled, filename: outName });
            } catch (err) {
                toast(err?.message || 'Failed to compile PDF preview.', 'error');
            } finally {
                state.busy = false;
                updateActionButtons();
            }
        });
    });

    downloadCompiledBtns.forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!state.bytes || state.busy) return;
            state.busy = true;
            updateActionButtons();
            try {
                const compiled = await compileEditedPdf();
                const outName = `${stripPdfExtension(state.filename)}_edited.pdf`;
                downloadBlob(compiled, outName, 'application/pdf');
                toast(`Downloaded ${outName} (${formatBytes(compiled.byteLength)}).`, 'ok');
            } catch (err) {
                toast(err?.message || 'Failed to export edited PDF.', 'error');
            } finally {
                state.busy = false;
                updateActionButtons();
            }
        });
    });

    // Global keyboard shortcuts when editing
    document.addEventListener('keydown', (e) => {
        if (state.activeTab !== 'fill' && state.activeTab !== 'redact') return;
        if (sharedStageRoot.closest('.workspace-panel')?.hidden) return;
        if (document.body.classList.contains('modal-open')) return;

        const isMeta = e.ctrlKey || e.metaKey;
        const tag = (e.target && e.target.tagName) || '';
        const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

        if (isMeta && e.key.toLowerCase() === 'z' && !inInput) {
            e.preventDefault();
            if (e.shiftKey) redo();
            else undo();
            return;
        }
        if (isMeta && e.key.toLowerCase() === 'y' && !inInput) {
            e.preventDefault();
            redo();
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput && state.selectedOverlayId !== null) {
            e.preventDefault();
            deleteOverlay(state.selectedOverlayId);
        }
    });

    initSignaturePad();
    updateTypePreview();
    renderFormSidebar();
    renderOverlaySidebar();
    renderInspector();
    updateActionButtons();

    return {
        setTab,
        handleFiles: handleInputChange,
        loadPdf: async (entry) => {
            switchToTab('fill');
            await loadPdfDocument(entry);
        },
        FONT_LABELS,
    };
}

// ---------- Geometry & Image Helpers ----------

function viewportNormToPdfBox(baseVp, nx, ny, nw, nh) {
    const x1 = nx * baseVp.width;
    const y1 = ny * baseVp.height;
    const x2 = (nx + nw) * baseVp.width;
    const y2 = (ny + nh) * baseVp.height;
    const [px1, py1] = baseVp.convertToPdfPoint(x1, y1);
    const [px2, py2] = baseVp.convertToPdfPoint(x2, y2);
    const left = Math.min(px1, px2);
    const right = Math.max(px1, px2);
    const bottom = Math.min(py1, py2);
    const top = Math.max(py1, py2);
    return {
        x: left,
        y: bottom,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, top - bottom),
    };
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function rgbToHex(r, g, b) {
    const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToPdfRgb(hex, rgbFn) {
    const clean = (hex || '#000000').replace('#', '');
    if (clean.length !== 6) return rgbFn(0, 0, 0);
    const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
    const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
    const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
    return rgbFn(r, g, b);
}

function dataUrlToUint8Array(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        arr[i] = bin.charCodeAt(i);
    }
    return arr;
}

function cropTransparentCanvas(src) {
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const w = src.width;
    const h = src.height;
    const data = ctx.getImageData(0, 0, w, h).data;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const alpha = data[(y * w + x) * 4 + 3];
            if (alpha > 10) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < minX || maxY < minY) return src;
    const pad = 10;
    const cx = Math.max(0, minX - pad);
    const cy = Math.max(0, minY - pad);
    const cw = Math.min(w - cx, maxX - minX + 1 + pad * 2);
    const ch = Math.min(h - cy, maxY - minY + 1 + pad * 2);

    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    out.getContext('2d').drawImage(src, cx, cy, cw, ch, 0, 0, cw, ch);
    return out;
}

function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to decode stamp image.'));
        img.src = url;
    });
}

async function processUploadedStamp(file, removeWhiteBg) {
    const objUrl = URL.createObjectURL(file);
    try {
        const img = await loadImageFromUrl(objUrl);
        const maxDim = 900;
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));

        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);

        if (removeWhiteBg) {
            const imgData = ctx.getImageData(0, 0, w, h);
            const d = imgData.data;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) {
                    d[i + 3] = 0;
                }
            }
            ctx.putImageData(imgData, 0, 0);
        }

        return cropTransparentCanvas(c).toDataURL('image/png');
    } finally {
        URL.revokeObjectURL(objUrl);
    }
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
