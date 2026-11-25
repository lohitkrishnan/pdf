// Phone layout for the Fill & Sign and Edit & Redact tabs (below 720px wide, once a PDF is open):
// the pages come first and fill the screen, the side panel becomes a pull-up sheet showing one
// section at a time, chosen from a dock fixed to the bottom, and two fingers pinch to zoom the
// pages (re-rendered sharp at the new size). Desktop layouts are untouched.

const SHEETS = {
    fill: [['fields', 'Form fields'], ['sign', 'Signature'], ['open', 'Open PDF'], ['save', 'Save']],
    redact: [['tools', 'Tools'], ['edits', 'Edits list'], ['open', 'Open PDF'], ['save', 'Save']],
};

export function initPhoneEditor({ shell, fillSidebar, redactSidebar, editor }) {
    const mq = matchMedia('(max-width: 720px)');
    const scroller = shell.querySelector('#ed-stage-scroll');
    const pagesEl = shell.querySelector('#ed-stage-pages');

    const dock = document.createElement('div');
    dock.className = 'pe-dock';
    dock.setAttribute('role', 'group');
    dock.setAttribute('aria-label', 'Editor panels');
    dock.hidden = true;
    document.body.appendChild(dock);

    // A header with a Done button at the top of each sidebar, shown only as a sheet.
    for (const side of [fillSidebar, redactSidebar]) {
        const head = document.createElement('div');
        head.className = 'pe-sheet-head';
        const title = document.createElement('strong');
        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'btn btn-ghost btn-sm';
        done.textContent = 'Done';
        done.addEventListener('click', () => openSheet(null));
        head.append(title, done);
        side.prepend(head);
    }

    let active = false;
    let tab = 'fill';
    let openKey = null;
    let lastTab = null;

    const sidebar = () => (tab === 'redact' ? redactSidebar : fillSidebar);

    function renderDock() {
        dock.innerHTML = '';
        for (const [key, label] of SHEETS[tab]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'pe-dock-btn';
            b.textContent = label;
            b.dataset.sheet = key;
            b.setAttribute('aria-expanded', String(openKey === key));
            b.classList.toggle('is-active', openKey === key);
            b.addEventListener('click', () => openSheet(openKey === key ? null : key));
            dock.appendChild(b);
        }
    }

    function openSheet(key) {
        openKey = key;
        for (const side of [fillSidebar, redactSidebar]) {
            side.classList.toggle('is-open', !!key && side === sidebar());
            if (key) side.dataset.sheet = key;
        }
        const label = key ? SHEETS[tab].find(([k]) => k === key)?.[1] : '';
        sidebar().querySelector('.pe-sheet-head strong').textContent = label || '';
        renderDock();
        requestAnimationFrame(layout);
    }

    function layout() {
        if (!active) return;
        const side = sidebar();
        document.documentElement.style.setProperty('--pe-dock-h', `${dock.offsetHeight}px`);
        document.documentElement.style.setProperty('--pe-sheet-h', `${side.classList.contains('is-open') ? side.offsetHeight : 0}px`);
    }

    function update() {
        const visible = !shell.hidden;
        tab = !redactSidebar.hidden ? 'redact' : 'fill';
        const next = mq.matches && visible && editor.hasDocument();
        if (next !== active) {
            active = next;
            document.body.classList.toggle('pe-phone', active);
            dock.hidden = !active;
            if (!active) {
                openSheet(null);
                document.documentElement.style.removeProperty('--pe-dock-h');
                document.documentElement.style.removeProperty('--pe-sheet-h');
            } else {
                // Bring the pages to the top of the screen.
                requestAnimationFrame(() => shell.querySelector('#ed-stage-root').scrollIntoView({ block: 'start' }));
            }
        }
        if (active) {
            if (openKey && !SHEETS[tab].some(([k]) => k === openKey)) openKey = null;
            if (tab !== lastTab) {
                // Switching between Fill & Sign and Edit & Redact: show the pages again.
                requestAnimationFrame(() => shell.querySelector('#ed-stage-root').scrollIntoView({ block: 'start' }));
            }
            openSheet(openKey);
        }
        lastTab = tab;
    }

    // Picking a tool, placing a signature or opening another PDF closes the sheet so the page
    // is visible again.
    shell.addEventListener('click', (e) => {
        if (!active || !openKey) return;
        const t = e.target.closest('button');
        if (!t) return;
        if (t.matches('.js-ed-tool, #ed4-verified-btn, [id^="ed3-sig-place"], #ed3-upload-btn, #ed4-upload-btn, #ed3-sample-btn, #ed4-sample-btn')) {
            setTimeout(() => openSheet(null), 0);
        }
    });

    mq.addEventListener?.('change', update);
    const mo = new MutationObserver(update);
    mo.observe(shell, { attributes: true, attributeFilter: ['hidden'] });
    mo.observe(redactSidebar, { attributes: true, attributeFilter: ['hidden'] });
    mo.observe(pagesEl, { attributes: true, attributeFilter: ['hidden'] });
    new ResizeObserver(() => layout()).observe(fillSidebar);
    new ResizeObserver(() => layout()).observe(redactSidebar);

    // ---------- Pinch to zoom the pages ----------
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    scroller.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2 || !editor.hasDocument()) return;
        const m = mid(e.touches);
        const pr = pagesEl.getBoundingClientRect();
        // Remember which page is under the fingers, and where on it, so it can be put back
        // under the fingers after re-rendering at the new size.
        const cards = Array.from(pagesEl.querySelectorAll('.ed-page-card'));
        let idx = cards.findIndex((c) => {
            const r = c.getBoundingClientRect();
            return m.y >= r.top && m.y <= r.bottom;
        });
        if (idx < 0) idx = 0;
        const canvas = cards[idx]?.querySelector('canvas');
        const cr = (canvas || cards[idx] || pagesEl).getBoundingClientRect();
        pinch = {
            d0: Math.max(1, dist(e.touches)), m, s: 1, z0: editor.getZoom(), idx,
            u: (m.x - cr.left) / Math.max(1, cr.width), v: (m.y - cr.top) / Math.max(1, cr.height),
        };
        pagesEl.style.transformOrigin = `${m.x - pr.left}px ${m.y - pr.top}px`;
        pagesEl.style.willChange = 'transform';
    }, { passive: true });

    scroller.addEventListener('touchmove', (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        pinch.s = Math.max(0.35 / pinch.z0, Math.min(3 / pinch.z0, dist(e.touches) / pinch.d0));
        pagesEl.style.transform = `scale(${pinch.s})`;
    }, { passive: false });

    const endPinch = async () => {
        if (!pinch) return;
        const p = pinch;
        pinch = null;
        if (Math.abs(p.s - 1) < 0.03) {
            pagesEl.style.transform = '';
            pagesEl.style.willChange = '';
            return;
        }
        await editor.setZoom(p.z0 * p.s);
        pagesEl.style.transform = '';
        pagesEl.style.willChange = '';
        // Put the same spot on the same page back under the fingers.
        const card = pagesEl.querySelectorAll('.ed-page-card')[p.idx];
        const target = (card?.querySelector('canvas') || card);
        if (target) {
            const r = target.getBoundingClientRect();
            scroller.scrollLeft += r.left + p.u * r.width - p.m.x;
            scroller.scrollTop += r.top + p.v * r.height - p.m.y;
        }
    };
    scroller.addEventListener('touchend', (e) => { if (e.touches.length < 2) endPinch(); });
    scroller.addEventListener('touchcancel', endPinch);

    update();
    return { update };
}
