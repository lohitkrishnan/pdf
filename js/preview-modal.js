import { pdfjsLib, formatBytes, downloadBlob, capScale } from './pdf-utils.js';

let modalEl = null;
let currentPdf = null;
let currentBytes = null;
let currentFilename = 'document.pdf';
let currentPassword = '';
let currentZoom = 1.15;
let renderSeq = 0;

function ensureModalDom() {
    if (modalEl) return modalEl;

    modalEl = document.createElement('div');
    modalEl.id = 'pdf-preview-modal';
    modalEl.className = 'modal-backdrop';
    modalEl.hidden = true;
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-labelledby', 'preview-modal-title');

    modalEl.innerHTML = `
        <div class="modal-dialog preview-dialog">
            <header class="modal-header">
                <div class="modal-title-group">
                    <h2 id="preview-modal-title" class="modal-title">Document Preview</h2>
                    <span id="preview-modal-meta" class="modal-meta"></span>
                    <span id="preview-modal-badge" class="badge badge-warn" hidden>Previewing with open password</span>
                </div>
                <div class="modal-actions">
                    <div class="zoom-controls" aria-label="Preview zoom">
                        <button type="button" class="btn btn-ghost btn-sm" id="preview-zoom-out" title="Zoom out">−</button>
                        <span id="preview-zoom-label" class="zoom-label">115%</span>
                        <button type="button" class="btn btn-ghost btn-sm" id="preview-zoom-in" title="Zoom in">+</button>
                        <button type="button" class="btn btn-ghost btn-sm" id="preview-zoom-fit" title="Fit width">Fit</button>
                    </div>
                    <button type="button" class="btn btn-primary btn-sm" id="preview-download-btn">Download PDF</button>
                    <button type="button" class="btn btn-ghost btn-sm" id="preview-close-btn" aria-label="Close preview">✕<span class="esc-hint"> Esc</span></button>
                </div>
            </header>
            <div class="preview-body" id="preview-modal-body"></div>
        </div>
    `;

    document.body.appendChild(modalEl);

    modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) closePreviewModal();
    });

    modalEl.querySelector('#preview-close-btn').addEventListener('click', closePreviewModal);
    modalEl.querySelector('#preview-download-btn').addEventListener('click', () => {
        if (currentBytes) {
            downloadBlob(currentBytes, currentFilename, 'application/pdf');
        }
    });
    modalEl.querySelector('#preview-zoom-out').addEventListener('click', () => {
        currentZoom = Math.max(0.5, Number((currentZoom - 0.15).toFixed(2)));
        renderPreviewPages();
    });
    modalEl.querySelector('#preview-zoom-in').addEventListener('click', () => {
        currentZoom = Math.min(2.5, Number((currentZoom + 0.15).toFixed(2)));
        renderPreviewPages();
    });
    modalEl.querySelector('#preview-zoom-fit').addEventListener('click', async () => {
        if (!currentPdf) return;
        const page = await currentPdf.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const body = modalEl.querySelector('#preview-modal-body');
        const avail = Math.max(320, body.clientWidth - 64);
        currentZoom = Math.max(0.5, Math.min(2.2, Number((avail / vp.width).toFixed(2))));
        renderPreviewPages();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalEl && !modalEl.hidden) {
            e.preventDefault();
            closePreviewModal();
        }
    });

    return modalEl;
}

let previewObserver = null;
const PREVIEW_MARGIN_PX = 1200;

// Pages are laid out at their final size up front, but only pages near the visible area get a
// bitmap; bitmaps far off-screen are released. Every await re-checks renderSeq so a zoom change
// or close mid-render can't append stale pages.
async function renderPreviewPages() {
    if (!modalEl || !currentPdf) return;
    const seq = ++renderSeq;
    const pdf = currentPdf;
    const body = modalEl.querySelector('#preview-modal-body');
    const zoomLabel = modalEl.querySelector('#preview-zoom-label');
    zoomLabel.textContent = `${Math.round(currentZoom * 100)}%`;

    if (previewObserver) previewObserver.disconnect();
    body.replaceChildren();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const zoom = currentZoom;
    const slots = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        if (seq !== renderSeq) return;
        const vp = page.getViewport({ scale: zoom });

        const wrap = document.createElement('div');
        wrap.className = 'preview-page-card';
        wrap.dataset.page = String(i);

        const label = document.createElement('div');
        label.className = 'preview-page-num';
        label.textContent = `Page ${i} of ${pdf.numPages}`;

        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        canvas.style.background = '#ffffff';

        wrap.append(label, canvas);
        body.appendChild(wrap);
        slots.push({ page, vp, canvas, rendered: false, rendering: null });
    }

    const drawSlot = (slot) => {
        if (slot.rendered || slot.rendering) return slot.rendering;
        const r = capScale(slot.vp.width, slot.vp.height, dpr); // stays within the device's canvas limit
        slot.canvas.width = Math.max(1, Math.round(slot.vp.width * r));
        slot.canvas.height = Math.max(1, Math.round(slot.vp.height * r));
        const ctx = slot.canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, slot.canvas.width, slot.canvas.height);
        slot.rendering = slot.page.render({
            canvasContext: ctx,
            viewport: slot.vp,
            transform: r !== 1 ? [r, 0, 0, r, 0, 0] : null,
        }).promise
            .then(() => { if (seq === renderSeq) slot.rendered = true; })
            .catch(() => {})
            .finally(() => { slot.rendering = null; });
        return slot.rendering;
    };
    const releaseSlot = (slot) => {
        if (!slot.rendered || slot.rendering) return;
        slot.canvas.width = 1;
        slot.canvas.height = 1;
        slot.rendered = false;
    };

    if ('IntersectionObserver' in window) {
        previewObserver = new IntersectionObserver((entries) => {
            if (seq !== renderSeq) return;
            for (const entry of entries) {
                const slot = slots[Number(entry.target.dataset.page) - 1];
                if (!slot) continue;
                if (entry.isIntersecting) drawSlot(slot);
                else releaseSlot(slot);
            }
        }, { root: body, rootMargin: `${PREVIEW_MARGIN_PX}px 0px` });
        body.querySelectorAll('.preview-page-card').forEach((el) => previewObserver.observe(el));
    } else {
        for (const slot of slots) {
            if (seq !== renderSeq) return;
            await drawSlot(slot);
        }
    }
}

export async function openPreviewModal({ bytes, filename = 'document.pdf', password = '' }) {
    const el = ensureModalDom();
    currentBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    currentFilename = filename;
    currentPassword = password || '';

    const titleEl = el.querySelector('#preview-modal-title');
    const metaEl = el.querySelector('#preview-modal-meta');
    const badgeEl = el.querySelector('#preview-modal-badge');
    const dlBtn = el.querySelector('#preview-download-btn');
    const body = el.querySelector('#preview-modal-body');

    titleEl.textContent = filename;
    metaEl.textContent = `Loading · ${formatBytes(currentBytes.byteLength)}`;
    badgeEl.hidden = !currentPassword;
    dlBtn.textContent = `Download ${filename}`;
    body.innerHTML = '<div class="preview-loading">Rendering PDF pages locally…</div>';

    el.hidden = false;
    document.body.classList.add('modal-open');

    if (currentPdf) {
        try {
            await currentPdf.destroy();
        } catch {
            // ignore cleanup errors
        }
        currentPdf = null;
    }

    try {
        const task = pdfjsLib.getDocument({
            data: currentBytes.slice(0),
            ...(currentPassword ? { password: currentPassword } : {}),
        });
        currentPdf = await task.promise;
        metaEl.textContent = `${currentPdf.numPages} page${currentPdf.numPages === 1 ? '' : 's'} · ${formatBytes(currentBytes.byteLength)}`;

        // Auto-fit nicely inside modal viewport on first open
        const firstPage = await currentPdf.getPage(1);
        const vp = firstPage.getViewport({ scale: 1 });
        const avail = Math.max(320, body.clientWidth - 64);
        currentZoom = Math.max(0.65, Math.min(1.25, Number((avail / vp.width).toFixed(2))));

        await renderPreviewPages();
    } catch (err) {
        if (err && err.name === 'PasswordException') {
            const wrongPassword = err.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
            body.innerHTML = `
                <div class="preview-password-box">
                    <p>This PDF requires a User (open) password to preview.</p>
                    ${wrongPassword ? '<p class="preview-pw-error" role="alert">That password didn’t work. Try again.</p>' : ''}
                    <form id="preview-pw-form" class="inline-form">
                        <input type="password" id="preview-pw-input" class="input" placeholder="Enter open password" required />
                        <button type="submit" class="btn btn-primary btn-sm">Unlock Preview</button>
                    </form>
                </div>
            `;
            body.querySelector('#preview-pw-form').addEventListener('submit', (ev) => {
                ev.preventDefault();
                const entered = body.querySelector('#preview-pw-input').value;
                openPreviewModal({ bytes: currentBytes, filename: currentFilename, password: entered });
            });
        } else {
            const errorEl = document.createElement('div');
            errorEl.className = 'preview-error';
            errorEl.textContent = `Unable to preview PDF: ${err?.message || 'Unknown error'}`;
            body.replaceChildren(errorEl);
        }
    }
}

export async function closePreviewModal() {
    if (!modalEl || modalEl.hidden) return;
    renderSeq += 1;
    modalEl.hidden = true;
    document.body.classList.remove('modal-open');
    if (previewObserver) {
        previewObserver.disconnect();
        previewObserver = null;
    }
    modalEl.querySelector('#preview-modal-body')?.replaceChildren();
    // Don't keep the last previewed PDF in memory after the modal is closed.
    currentBytes = null;
    if (currentPdf) {
        try {
            await currentPdf.destroy();
        } catch {
            // ignore
        }
        currentPdf = null;
    }
}
