// Phone and tablet helpers shared by the studio apps. Nothing here changes how the apps behave
// with a mouse on a desktop computer.
//
// 1. deliverFile(): on touch devices that can share files, a finished file opens a small sheet
//    with Share (WhatsApp, Gmail, Files, …) and Save buttons instead of downloading straight
//    away. Each button is its own tap, which phones require before sharing or downloading.
// 2. initMobileCta(): on narrow screens, the main button of the visible tool (Process, Create
//    PDF, Download, …) is mirrored in a bar pinned to the bottom of the screen whenever the real
//    button is scrolled out of view.

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

let shareSupport = null;
function canShareFiles() {
    if (shareSupport === null) {
        try {
            shareSupport = !!(navigator.share && navigator.canShare
                && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));
        } catch {
            shareSupport = false;
        }
    }
    return shareSupport;
}

function saveDirect(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

let pending = []; // { blob, filename }
let lastDeliverAt = 0;
let sheet = null;

function closeSheet() {
    pending = [];
    sheet?.remove();
    sheet = null;
}

function renderSheet() {
    if (!sheet) {
        sheet = document.createElement('div');
        sheet.className = 'deliver-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-label', 'Your file is ready');
        document.body.appendChild(sheet);
    }
    const total = pending.reduce((a, p) => a + p.blob.size, 0);
    const one = pending.length === 1;
    sheet.innerHTML = '';
    const info = document.createElement('div');
    info.className = 'deliver-info';
    const name = document.createElement('strong');
    name.textContent = one ? pending[0].filename : `${pending.length} files ready`;
    const meta = document.createElement('span');
    meta.textContent = formatSize(total);
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'deliver-actions';
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'btn btn-primary btn-sm';
    share.textContent = one ? 'Share' : 'Share all';
    share.addEventListener('click', async () => {
        const files = pending.map((p) => new File([p.blob], p.filename, { type: p.blob.type || 'application/octet-stream' }));
        let ok = false;
        try {
            ok = navigator.canShare({ files });
        } catch {
            ok = false;
        }
        if (!ok) {
            // Some apps can't take this file type (or this many files); save instead.
            pending.forEach((p) => saveDirect(p.blob, p.filename));
            closeSheet();
            return;
        }
        try {
            await navigator.share({ files, title: one ? pending[0].filename : undefined });
            closeSheet();
        } catch (err) {
            if (err && err.name === 'AbortError') return; // the user closed the share menu
            pending.forEach((p) => saveDirect(p.blob, p.filename));
            closeSheet();
        }
    });
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-secondary btn-sm';
    save.textContent = one ? 'Save to device' : 'Save all';
    save.addEventListener('click', () => {
        pending.forEach((p) => saveDirect(p.blob, p.filename));
        closeSheet();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-ghost btn-sm deliver-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', closeSheet);
    actions.append(share, save, close);
    sheet.append(info, actions);
    share.focus({ preventScroll: true });
}

/** Hand a finished file to the user: share sheet on phones that support it, download elsewhere. */
export function deliverFile(blob, filename) {
    if (!coarse() || !canShareFiles()) {
        saveDirect(blob, filename);
        return;
    }
    // Files produced together (a batch) share one sheet; a later export replaces what is
    // waiting, so an old version is never shared along with the new one.
    const now = Date.now();
    if (now - lastDeliverAt > 2500) pending = [];
    lastDeliverAt = now;
    pending.push({ blob, filename });
    renderSheet();
    // Editors close their own pull-up panels so this one isn't stacked on top of them.
    document.dispatchEvent(new CustomEvent('deliver:open'));
}

/**
 * Mirror each workspace's main button in a bar fixed to the bottom of narrow screens, shown only
 * while that workspace is visible and its real button is off screen.
 */
export function initMobileCta() {
    const narrow = matchMedia('(max-width: 960px)');
    const bar = document.createElement('div');
    bar.className = 'mobile-cta';
    bar.hidden = true;
    const proxy = document.createElement('button');
    proxy.type = 'button';
    proxy.className = 'btn btn-primary';
    bar.appendChild(proxy);
    document.body.appendChild(bar);

    const targets = Array.from(document.querySelectorAll('[data-mobile-cta]'));
    let current = null;

    // A button counts as "out of view" when it is rendered but below the bottom of the screen.
    // Once the user scrolls past it (it's above them), the bar isn't needed.
    const below = (el) => {
        if (!el.getClientRects().length) return false; // hidden tab or panel
        if (getComputedStyle(el).visibility === 'hidden') return false; // inside a closed sheet
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top > window.innerHeight - 8;
    };

    function update() {
        current = narrow.matches ? targets.find(below) || null : null;
        // Only touch the DOM when something changed: the observer below would otherwise see our
        // own edits and loop.
        if (bar.hidden !== !current) bar.hidden = !current;
        document.body.classList.toggle('has-mobile-cta', !!current);
        if (current) {
            const label = current.textContent.trim();
            if (proxy.textContent !== label) proxy.textContent = label;
            if (proxy.disabled !== current.disabled) proxy.disabled = current.disabled;
        }
    }

    let queued = false;
    const schedule = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            update();
        });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Labels, enabled state, tab switches and growing lists all move or change the buttons.
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['disabled', 'hidden'], childList: true, characterData: true, subtree: true });
    narrow.addEventListener?.('change', schedule);

    proxy.addEventListener('click', () => {
        if (current && !current.disabled) current.click();
    });
    update();
}

/**
 * "Take photo" buttons: <button data-camera-for="some-file-input">. Opens the camera and passes
 * the photo to that file input as if it had been chosen there. Shown only on touch screens (CSS).
 */
export function wireCameraButtons() {
    document.querySelectorAll('[data-camera-for]').forEach((btn) => {
        const target = document.getElementById(btn.dataset.cameraFor);
        if (!target) return;
        const cam = document.createElement('input');
        cam.type = 'file';
        cam.accept = 'image/*';
        cam.setAttribute('capture', btn.dataset.camera || 'environment');
        cam.hidden = true;
        btn.after(cam);
        btn.addEventListener('click', () => cam.click());
        cam.addEventListener('change', () => {
            const files = Array.from(cam.files || []);
            cam.value = '';
            if (!files.length) return;
            const dt = new DataTransfer();
            files.forEach((f) => dt.items.add(f));
            target.files = dt.files;
            target.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });
}

/**
 * On phones the row of workspace tabs doesn't fit, so it is replaced (by CSS, below 720px) with
 * one "current tool ▾" button that opens a menu of all tools. The menu just clicks the real tab,
 * so tab switching logic stays in one place.
 */
export function initToolSwitcher() {
    const tablist = document.querySelector('[role="tablist"].workspace-tabs');
    if (!tablist) return;
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    const wrap = document.createElement('div');
    wrap.className = 'tool-switcher';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-switcher-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.className = 'tool-switcher-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.id = 'tool-switcher-menu';
    btn.setAttribute('aria-controls', menu.id);

    const items = tabs.map((tab) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'tool-switcher-item';
        item.setAttribute('role', 'menuitemradio');
        item.innerHTML = tab.innerHTML;
        item.addEventListener('click', () => {
            close();
            tab.click();
            btn.focus();
        });
        menu.appendChild(item);
        return item;
    });

    function sync() {
        const i = Math.max(0, tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
        btn.innerHTML = `${tabs[i].innerHTML}<span class="tool-switcher-caret" aria-hidden="true">▾</span>`;
        btn.setAttribute('aria-label', `Tool: ${tabs[i].textContent.replace(/\s+/g, ' ').trim()}. Change tool`);
        items.forEach((it, j) => {
            it.setAttribute('aria-checked', String(j === i));
            it.classList.toggle('is-active', j === i);
        });
    }

    function open() {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        (items.find((it) => it.classList.contains('is-active')) || items[0]).focus();
    }
    function close() {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', () => (menu.hidden ? open() : close()));
    menu.addEventListener('keydown', (e) => {
        const i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
        else if (e.key === 'Escape' || e.key === 'Tab') { close(); if (e.key === 'Escape') btn.focus(); }
    });
    document.addEventListener('pointerdown', (e) => {
        if (!menu.hidden && !wrap.contains(e.target)) close();
    });

    wrap.append(btn, menu);
    tablist.after(wrap);
    new MutationObserver(sync).observe(tablist, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
    sync();
}

/**
 * Files shared into the installed app from another app arrive through the service worker
 * (sw.js), which parks them in a cache and opens the app with ?shared=1. Returns them as File
 * objects (and clears the cache), or [] when there are none.
 */
export async function takeSharedFiles(cacheName) {
    const params = new URLSearchParams(location.search);
    if (!params.has('shared') || !('caches' in window)) return [];
    history.replaceState(null, '', location.pathname + location.hash);
    try {
        const cache = await caches.open(cacheName);
        const index = await cache.match('./shared/index');
        if (!index) return [];
        const list = await index.json();
        const files = [];
        for (const item of list) {
            const res = await cache.match(item.key);
            if (res) files.push(new File([await res.blob()], item.name, { type: item.type }));
        }
        await caches.delete(cacheName);
        return files;
    } catch {
        return [];
    }
}

/** A small dialog asking which tool to open shared files in. Options: [{ label, desc, onPick }]. */
export function chooseTool({ title, options }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dlg = document.createElement('div');
    dlg.className = 'modal-dialog modal-dialog-sm chooser-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'chooser-title');
    const h = document.createElement('div');
    h.className = 'modal-header';
    h.innerHTML = '<h2 class="modal-title" id="chooser-title"></h2>';
    h.querySelector('h2').textContent = title;
    const body = document.createElement('div');
    body.className = 'modal-body-pad chooser-list';
    const close = () => backdrop.remove();
    options.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chooser-item';
        const strong = document.createElement('strong');
        strong.textContent = o.label;
        const span = document.createElement('span');
        span.textContent = o.desc || '';
        b.append(strong, span);
        b.addEventListener('click', () => {
            close();
            o.onPick();
        });
        body.appendChild(b);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    body.appendChild(cancel);
    dlg.append(h, body);
    backdrop.appendChild(dlg);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.appendChild(backdrop);
    body.querySelector('.chooser-item')?.focus();
}
