import { pdfjsLib, formatBytes, downloadBlob } from './pdf-utils.js';

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
                    <button type="button" class="btn btn-ghost btn-sm" id="preview-close-btn" aria-label="Close preview">✕ Esc</button>
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

async function renderPreviewPages() {
    if (!modalEl || !currentPdf) return;
    const seq = ++renderSeq;
    const body = modalEl.querySelector('#preview-modal-body');
    const zoomLabel = modalEl.querySelector('#preview-zoom-label');
    zoomLabel.textContent = `${Math.round(currentZoom * 100)}%`;

    body.innerHTML = '';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    for (let i = 1; i <= currentPdf.numPages; i++) {
        if (seq !== renderSeq) return;
        const page = await currentPdf.getPage(i);
        const vp = page.getViewport({ scale: currentZoom });

        const wrap = document.createElement('div');
        wrap.className = 'preview-page-card';

        const label = document.createElement('div');
        label.className = 'preview-page-num';
        label.textContent = `Page ${i} of ${currentPdf.numPages}`;

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vp.width * dpr));
        canvas.height = Math.max(1, Math.round(vp.height * dpr));
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;

        wrap.append(label, canvas);
        body.appendChild(wrap);

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
            canvasContext: ctx,
            viewport: vp,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        }).promise;
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
            body.innerHTML = `
                <div class="preview-password-box">
                    <p>This PDF requires a User (open) password to preview.</p>
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
            body.innerHTML = `<div class="preview-error">Unable to preview PDF: ${err?.message || 'Unknown error'}</div>`;
        }
    }
}

export async function closePreviewModal() {
    if (!modalEl || modalEl.hidden) return;
    renderSeq += 1;
    modalEl.hidden = true;
    document.body.classList.remove('modal-open');
    if (currentPdf) {
        try {
            await currentPdf.destroy();
        } catch {
            // ignore
        }
        currentPdf = null;
    }
}
