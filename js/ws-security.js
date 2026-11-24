import { inspectPdf, unlockAndCompressDetailed, lockPdf } from './qpdf-engine.js';
import {
    formatBytes,
    formatDeltaPct,
    applySuffix,
    downloadBlob,
    readFileBytes,
    isPdfFile,
    stripPdfExtension,
} from './pdf-utils.js';
import { openPreviewModal } from './preview-modal.js';
import { createZip } from './zip.js';
import { createEncryptedSample } from './samples.js';

export function initSecurityWorkspace({ root, toast, handoffToOrganizer, handoffToEditor }) {
    const state = {
        mode: 'unlock', // 'unlock' | 'lock'
        items: [], // { id, name, bytes, info, passwordOverride, status, error, outputBytes, outputName, outputPassword }
        masterPassword: '',
        compression: 'lossless', // 'lossless' | 'balanced' | 'maximum' | 'off'
        suffix: '_unlocked',
        suffixTouched: false,
        autoDownload: false,
        lockOpts: {
            userPassword: '',
            ownerPassword: '',
            cipher: '256',
            print: 'full',
            modify: 'all',
            extract: 'y',
            compression: 'off',
        },
        busy: false,
    };

    let nextId = 1;

    const dropzone = root.querySelector('#sec-dropzone');
    const fileInput = root.querySelector('#sec-file-input');
    const sampleBtn = root.querySelector('#sec-sample-btn');
    const clearBtn = root.querySelector('#sec-clear-btn');
    const queueList = root.querySelector('#sec-queue-list');
    const emptyState = root.querySelector('#sec-empty-state');

    const modeUnlockBtn = root.querySelector('#sec-mode-unlock');
    const modeLockBtn = root.querySelector('#sec-mode-lock');
    const unlockPanel = root.querySelector('#sec-unlock-panel');
    const lockPanel = root.querySelector('#sec-lock-panel');

    const masterPwInput = root.querySelector('#sec-master-pw');
    const masterPwToggle = root.querySelector('#sec-master-pw-toggle');
    const sampleHintBtn = root.querySelector('#sec-sample-pw-hint');

    const suffixSelect = root.querySelector('#sec-suffix');
    const autoDownloadCb = root.querySelector('#sec-auto-download');
    const runBtn = root.querySelector('#sec-run-btn');

    const userPwInput = root.querySelector('#sec-user-pw');
    const ownerPwInput = root.querySelector('#sec-owner-pw');
    const cipherSelect = root.querySelector('#sec-cipher');
    const printSelect = root.querySelector('#sec-perm-print');
    const modifySelect = root.querySelector('#sec-perm-modify');
    const extractSelect = root.querySelector('#sec-perm-extract');
    const lockCompSelect = root.querySelector('#sec-lock-compression');

    const summaryBar = root.querySelector('#sec-summary-bar');
    const summaryText = root.querySelector('#sec-summary-text');
    const downloadAllBtn = root.querySelector('#sec-download-all-btn');
    const sendOrgBtn = root.querySelector('#sec-send-organizer-btn');
    const sendEditBtn = root.querySelector('#sec-send-editor-btn');

    function setMode(mode) {
        state.mode = mode;
        modeUnlockBtn.classList.toggle('is-active', mode === 'unlock');
        modeLockBtn.classList.toggle('is-active', mode === 'lock');
        unlockPanel.hidden = mode !== 'unlock';
        lockPanel.hidden = mode !== 'lock';

        if (!state.suffixTouched) {
            if (mode === 'unlock') {
                state.suffix = state.compression === 'off' ? '_unlocked' : '_compressed';
            } else {
                state.suffix = '_locked';
            }
            suffixSelect.value = state.suffix;
        }

        runBtn.textContent =
            mode === 'unlock'
                ? (state.items.length > 1 ? `Unlock & Process ${state.items.length} PDFs` : 'Unlock / Compress PDF')
                : (state.items.length > 1 ? `Lock ${state.items.length} PDFs` : 'Lock / Encrypt PDF');
    }

    function renderBadge(info) {
        if (!info) return '<span class="badge">Inspecting…</span>';
        if (info.encryptionState === 'password_required') {
            return info.unlockedWithPassword
                ? '<span class="badge badge-ok">Password Verified</span>'
                : '<span class="badge badge-danger">Password Required</span>';
        }
        if (info.encryptionState === 'invalid') {
            return '<span class="badge badge-danger">Unreadable</span>';
        }
        if (info.encryptionState === 'permissions_locked') {
            return '<span class="badge badge-warn">Permissions Locked (No open password)</span>';
        }
        return '<span class="badge badge-neutral">Unencrypted</span>';
    }

    function updateSummary() {
        const processed = state.items.filter((it) => it.outputBytes);
        const hasAny = state.items.length > 0;
        clearBtn.disabled = !hasAny || state.busy;
        runBtn.disabled = !hasAny || state.busy;
        summaryBar.hidden = !hasAny;

        sendOrgBtn.disabled = !hasAny || state.busy;
        sendEditBtn.disabled = !hasAny || state.busy;
        downloadAllBtn.disabled = processed.length === 0 || state.busy;

        if (processed.length > 0) {
            const totalOrig = processed.reduce((sum, it) => sum + it.bytes.byteLength, 0);
            const totalOut = processed.reduce((sum, it) => sum + it.outputBytes.byteLength, 0);
            const delta = formatDeltaPct(totalOrig, totalOut);
            summaryText.innerHTML = `<strong>${processed.length}/${state.items.length}</strong> processed · Total: <strong>${formatBytes(totalOrig)}</strong> → <strong>${formatBytes(totalOut)}</strong> <span class="delta-pill ${totalOut <= totalOrig ? 'is-saved' : ''}">${delta}</span>`;
            downloadAllBtn.textContent = processed.length > 1 ? `Download All (${processed.length} in .zip)` : 'Download Processed PDF';
        } else {
            const totalOrig = state.items.reduce((sum, it) => sum + it.bytes.byteLength, 0);
            summaryText.textContent = `${state.items.length} file${state.items.length === 1 ? '' : 's'} queued (${formatBytes(totalOrig)})`;
            downloadAllBtn.textContent = 'Download All Processed';
        }

        setMode(state.mode);
    }

    function renderQueue() {
        emptyState.hidden = state.items.length > 0;
        queueList.innerHTML = '';

        for (const item of state.items) {
            const card = document.createElement('div');
            card.className = `queue-card ${item.status === 'error' ? 'is-error' : ''} ${item.outputBytes ? 'is-done' : ''}`;
            card.dataset.id = String(item.id);

            const info = item.info;
            const metaLine = info
                ? `PDF ${info.version} · ${info.pageCount != null ? `${info.pageCount} page${info.pageCount === 1 ? '' : 's'}` : '? pages'} · ${formatBytes(item.bytes.byteLength)}`
                : formatBytes(item.bytes.byteLength);

            let resultHtml = '';
            if (item.status === 'processing') {
                resultHtml = '<div class="queue-status">Processing locally with QPDF…</div>';
            } else if (item.status === 'error') {
                resultHtml = `<div class="queue-status is-error">${escapeHtml(item.error)}</div>`;
            } else if (item.outputBytes) {
                const delta = formatDeltaPct(item.bytes.byteLength, item.outputBytes.byteLength);
                const savedClass = item.outputBytes.byteLength <= item.bytes.byteLength ? 'is-saved' : '';
                resultHtml = `
                    <div class="queue-result">
                        <span>Output: <strong>${escapeHtml(item.outputName)}</strong> (${formatBytes(item.outputBytes.byteLength)})</span>
                        <span class="delta-pill ${savedClass}">${delta}</span>
                    </div>
                    ${item.note ? `<div class="queue-status queue-note">${escapeHtml(item.note)}</div>` : ''}
                `;
            }

            card.innerHTML = `
                <div class="queue-card-main">
                    <div class="queue-card-title-row">
                        <strong class="queue-filename" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
                        ${renderBadge(info)}
                    </div>
                    <div class="queue-meta">${metaLine}${info?.details ? ` · <span class="muted">${escapeHtml(info.details)}</span>` : ''}</div>
                    ${resultHtml}
                </div>
                <div class="queue-card-controls">
                    <input
                        type="password"
                        class="input input-sm queue-pw-input"
                        placeholder="${info?.encryptionState === 'password_required' ? 'Per-file password override' : 'Optional file password'}"
                        value="${escapeHtml(item.passwordOverride)}"
                        aria-label="Password override for ${escapeHtml(item.name)}"
                    />
                    <div class="queue-card-btns">
                        <button type="button" class="btn btn-ghost btn-sm js-preview" title="Preview PDF">Preview</button>
                        ${item.outputBytes ? '<button type="button" class="btn btn-secondary btn-sm js-download">Download</button>' : ''}
                        <button type="button" class="btn btn-ghost btn-sm js-remove" title="Remove from queue" aria-label="Remove">✕</button>
                    </div>
                </div>
            `;

            const pwInput = card.querySelector('.queue-pw-input');
            pwInput.addEventListener('input', (e) => {
                item.passwordOverride = e.target.value;
            });

            card.querySelector('.js-preview').addEventListener('click', () => {
                const bytesToPreview = item.outputBytes || item.bytes;
                const nameToPreview = item.outputBytes ? item.outputName : item.name;
                const pw = item.outputBytes ? (item.outputPassword || '') : (item.passwordOverride || state.masterPassword || '');
                openPreviewModal({ bytes: bytesToPreview, filename: nameToPreview, password: pw });
            });

            const dlBtn = card.querySelector('.js-download');
            if (dlBtn) {
                dlBtn.addEventListener('click', () => {
                    downloadBlob(item.outputBytes, item.outputName, 'application/pdf');
                });
            }

            card.querySelector('.js-remove').addEventListener('click', () => {
                state.items = state.items.filter((x) => x.id !== item.id);
                renderQueue();
            });

            queueList.appendChild(card);
        }

        updateSummary();
    }

    async function addEntries(entries) {
        const added = [];
        for (const entry of entries) {
            const item = {
                id: nextId++,
                name: entry.name,
                bytes: entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes),
                info: null,
                passwordOverride: entry.passwordOverride || '',
                status: 'ready',
                error: '',
                outputBytes: null,
                outputName: '',
                outputPassword: '',
            };
            state.items.push(item);
            added.push(item);
        }
        renderQueue();

        for (const item of added) {
            try {
                item.info = await inspectPdf(item.bytes, item.passwordOverride || state.masterPassword);
            } catch (err) {
                item.note = '';
                item.status = 'error';
                item.error = err?.message || 'Could not inspect PDF.';
            }
            renderQueue();
        }
    }

    async function handleFiles(fileList) {
        const files = Array.from(fileList || []).filter(isPdfFile);
        if (files.length === 0) {
            toast('Please drop or select one or more .pdf files.', 'warn');
            return;
        }
        const entries = await Promise.all(
            files.map(async (f) => ({ name: f.name, bytes: await readFileBytes(f) }))
        );
        await addEntries(entries);
    }

    // After a successful run the file has proven readable with this password, so update
    // the badge and fill in the page count if the initial inspection could not read it.
    async function refreshInfoAfterSuccess(item, password) {
        const info = item.info;
        if (!info) return;
        if (info.encryptionState === 'password_required' && password && !info.unlockedWithPassword) {
            info.unlockedWithPassword = password;
            info.details = 'Opened with the provided password';
        }
        if (info.pageCount == null) {
            try {
                const doc = await window.PDFLib.PDFDocument.load(item.outputBytes, { ignoreEncryption: true });
                info.pageCount = doc.getPageCount();
            } catch {
                // leave unknown
            }
        }
    }

    async function processAll() {
        if (state.items.length === 0 || state.busy) return;
        if (state.mode === 'lock' && !state.lockOpts.userPassword && !state.lockOpts.ownerPassword) {
            toast('Enter at least a User (open) password or an Owner (permissions) password to lock.', 'warn');
            userPwInput.focus();
            return;
        }

        state.busy = true;
        renderQueue();

        let successCount = 0;
        let failCount = 0;

        for (const item of state.items) {
            // Clear the previous run's result so a failed re-run can't leave a stale download behind.
            item.outputBytes = null;
            item.outputName = '';
            item.outputPassword = '';
            item.note = '';
            item.error = '';
            if (item.info?.encryptionState === 'invalid') {
                item.status = 'error';
                item.error = `Skipped: ${item.info.details}.`;
                failCount += 1;
                renderQueue();
                continue;
            }
            item.status = 'processing';
            renderQueue();

            const effectivePw = item.passwordOverride || state.masterPassword || '';

            try {
                let outBytes;
                let outPassword = '';

                let note = '';
                if (state.mode === 'unlock') {
                    const result = await unlockAndCompressDetailed(item.bytes, {
                        password: effectivePw,
                        compression: state.compression,
                    });
                    outBytes = result.bytes;
                    note = result.note;
                } else {
                    outBytes = await lockPdf(item.bytes, {
                        inputPassword: effectivePw,
                        userPassword: state.lockOpts.userPassword,
                        ownerPassword: state.lockOpts.ownerPassword,
                        cipher: state.lockOpts.cipher,
                        print: state.lockOpts.print,
                        modify: state.lockOpts.modify,
                        extract: state.lockOpts.extract,
                        compression: state.lockOpts.compression,
                    });
                    outPassword = state.lockOpts.userPassword || '';
                    const o = state.lockOpts;
                    if (!o.ownerPassword && (o.print !== 'full' || o.modify !== 'all' || o.extract !== 'y')) {
                        note = 'Restrictions are protected by a random owner password. Set your own Owner password if you may need to change them later.';
                    }
                }

                item.outputBytes = outBytes;
                item.outputName = applySuffix(item.name, state.suffix);
                item.outputPassword = outPassword;
                item.note = note;
                item.status = 'done';
                await refreshInfoAfterSuccess(item, effectivePw);
                successCount += 1;

                if (state.autoDownload) {
                    downloadBlob(item.outputBytes, item.outputName, 'application/pdf');
                }
            } catch (err) {
                item.status = 'error';
                item.error = err?.message || 'Processing failed.';
                failCount += 1;
            }
            renderQueue();
        }

        state.busy = false;
        renderQueue();

        if (failCount === 0) {
            toast(`Processed ${successCount} PDF${successCount === 1 ? '' : 's'} locally.`, 'ok');
        } else {
            toast(`Completed ${successCount}, failed ${failCount}. Check password overrides if needed.`, 'warn');
        }
    }

    // Bind UI events
    modeUnlockBtn.addEventListener('click', () => setMode('unlock'));
    modeLockBtn.addEventListener('click', () => setMode('lock'));

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

    masterPwInput.addEventListener('input', (e) => {
        state.masterPassword = e.target.value;
    });
    masterPwToggle.addEventListener('click', () => {
        const isPw = masterPwInput.type === 'password';
        masterPwInput.type = isPw ? 'text' : 'password';
        masterPwToggle.textContent = isPw ? 'Hide' : 'Show';
    });

    sampleHintBtn.addEventListener('click', () => {
        masterPwInput.value = 'secret123';
        state.masterPassword = 'secret123';
        toast('Master password filled with "secret123".', 'ok');
    });

    root.querySelectorAll('input[name="sec-compression"]').forEach((radio) => {
        radio.addEventListener('change', (e) => {
            if (!e.target.checked) return;
            state.compression = e.target.value;
            if (!state.suffixTouched && state.mode === 'unlock') {
                state.suffix = state.compression === 'off' ? '_unlocked' : '_compressed';
                suffixSelect.value = state.suffix;
            }
        });
    });

    suffixSelect.addEventListener('change', (e) => {
        state.suffix = e.target.value;
        state.suffixTouched = true;
    });
    autoDownloadCb.addEventListener('change', (e) => {
        state.autoDownload = e.target.checked;
    });

    userPwInput.addEventListener('input', (e) => { state.lockOpts.userPassword = e.target.value; });
    ownerPwInput.addEventListener('input', (e) => { state.lockOpts.ownerPassword = e.target.value; });
    cipherSelect.addEventListener('change', (e) => { state.lockOpts.cipher = e.target.value; });
    printSelect.addEventListener('change', (e) => { state.lockOpts.print = e.target.value; });
    modifySelect.addEventListener('change', (e) => { state.lockOpts.modify = e.target.value; });
    extractSelect.addEventListener('change', (e) => { state.lockOpts.extract = e.target.value; });
    lockCompSelect.addEventListener('change', (e) => { state.lockOpts.compression = e.target.value; });

    runBtn.addEventListener('click', processAll);

    clearBtn.addEventListener('click', () => {
        state.items = [];
        sampleHintBtn.hidden = true;
        renderQueue();
    });

    downloadAllBtn.addEventListener('click', () => {
        const processed = state.items.filter((it) => it.outputBytes);
        if (processed.length === 0) return;
        if (processed.length === 1) {
            downloadBlob(processed[0].outputBytes, processed[0].outputName, 'application/pdf');
            return;
        }
        const zipBytes = createZip(processed.map((it) => ({ name: it.outputName, data: it.outputBytes })));
        const prefix = stripPdfExtension(processed[0].name);
        downloadBlob(zipBytes, `${prefix}_batch_${processed.length}.zip`, 'application/zip');
        toast(`Packaged ${processed.length} PDFs into .zip`, 'ok');
    });

    sendOrgBtn.addEventListener('click', async () => {
        if (state.items.length === 0) return;
        const payload = state.items.map((it) => ({
            name: it.outputBytes ? it.outputName : it.name,
            bytes: it.outputBytes || it.bytes,
            password: it.outputBytes ? it.outputPassword : (it.passwordOverride || state.masterPassword),
        }));
        await handoffToOrganizer(payload);
    });

    sendEditBtn.addEventListener('click', async () => {
        if (state.items.length === 0) return;
        const target = state.items.find((it) => it.outputBytes) || state.items[0];
        await handoffToEditor({
            name: target.outputBytes ? target.outputName : target.name,
            bytes: target.outputBytes || target.bytes,
            password: target.outputBytes ? target.outputPassword : (target.passwordOverride || state.masterPassword),
        });
    });

    sampleBtn.addEventListener('click', async () => {
        sampleBtn.disabled = true;
        sampleBtn.textContent = 'Generating encrypted sample…';
        try {
            const sample = await createEncryptedSample();
            await addEntries([sample]);
            sampleHintBtn.hidden = false;
            toast('Loaded sample encrypted PDF (password: secret123).', 'ok');
        } catch (err) {
            toast(err?.message || 'Failed to create sample PDF.', 'error');
        } finally {
            sampleBtn.disabled = false;
            sampleBtn.textContent = 'Try Sample Encrypted PDF (secret123)';
        }
    });

    setMode('unlock');
    renderQueue();

    return {
        handleFiles,
    };
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
