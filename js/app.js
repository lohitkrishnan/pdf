import { initSecurityWorkspace } from './ws-security.js';
import { initOrganizerWorkspace } from './ws-organizer.js';
import { initEditorWorkspaces } from './ws-editor.js';

const THEME_KEY = 'lk_pdf_theme';

function initTheme() {
    const toggleBtn = document.getElementById('theme-toggle');
    const saved = localStorage.getItem(THEME_KEY);
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    let current = saved || (systemDark ? 'dark' : 'light');

    const apply = (theme) => {
        current = theme;
        document.documentElement.setAttribute('data-theme', theme);
        toggleBtn.textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
        toggleBtn.setAttribute('aria-pressed', String(theme === 'dark'));
    };

    apply(current);

    toggleBtn.addEventListener('click', () => {
        const next = current === 'dark' ? 'light' : 'dark';
        localStorage.setItem(THEME_KEY, next);
        apply(next);
    });
}

function createToaster() {
    const container = document.getElementById('toast-container');
    return function toast(message, level = 'info') {
        const el = document.createElement('div');
        el.className = `toast toast-${level}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.classList.add('is-leaving');
            setTimeout(() => el.remove(), 220);
        }, 4200);
    };
}

function initApp() {
    initTheme();
    const toast = createToaster();

    let activeTab = 'security';

    const navBtns = document.querySelectorAll('.js-nav-tab');
    const secPanel = document.getElementById('ws-security');
    const orgPanel = document.getElementById('ws-organizer');
    const edShell = document.getElementById('ws-editor-shell');
    const fillSidebar = document.getElementById('ws-fill-sidebar');
    const redactSidebar = document.getElementById('ws-redact-sidebar');
    const edStageRoot = document.getElementById('ed-stage-root');

    let organizerWs = null;
    let editorWs = null;

    function switchToTab(tab) {
        activeTab = tab;
        navBtns.forEach((b) => {
            const isActive = b.dataset.tab === tab;
            b.classList.toggle('is-active', isActive);
            b.setAttribute('aria-selected', String(isActive));
            b.tabIndex = isActive ? 0 : -1; // roving tabindex: Tab reaches the active tab only
        });
        if (tab === 'fill' || tab === 'redact') {
            edShell.setAttribute('aria-labelledby', `tab-${tab}`);
        }

        secPanel.hidden = tab !== 'security';
        orgPanel.hidden = tab !== 'organizer';
        const isEditor = tab === 'fill' || tab === 'redact';
        edShell.hidden = !isEditor;

        if (isEditor) {
            fillSidebar.hidden = tab !== 'fill';
            redactSidebar.hidden = tab !== 'redact';
            editorWs?.setTab(tab);
        }
    }

    const securityWs = initSecurityWorkspace({
        root: secPanel,
        toast,
        handoffToOrganizer: async (entries) => {
            switchToTab('organizer');
            await organizerWs.ingestHandoff(entries);
            toast(`Handed off ${entries.length} PDF${entries.length === 1 ? '' : 's'} to Merge / Split.`, 'ok');
        },
        handoffToEditor: async (entry) => {
            await editorWs.loadPdf(entry);
            toast(`Loaded "${entry.name}" in Fill, Edit & Sign.`, 'ok');
        },
    });

    organizerWs = initOrganizerWorkspace({
        root: orgPanel,
        toast,
        handoffToEditor: async (entry) => {
            await editorWs.loadPdf(entry);
            toast(`Sent merged PDF (${entry.name}) to Fill, Edit & Sign.`, 'ok');
        },
    });

    editorWs = initEditorWorkspaces({
        root3: fillSidebar,
        root4: redactSidebar,
        sharedStageRoot: edStageRoot,
        toast,
        switchToTab,
    });

    // Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
    const tabList = Array.from(navBtns);
    tabList.forEach((btn, i) => {
        btn.addEventListener('keydown', (e) => {
            let next = null;
            if (e.key === 'ArrowRight') next = tabList[(i + 1) % tabList.length];
            else if (e.key === 'ArrowLeft') next = tabList[(i - 1 + tabList.length) % tabList.length];
            else if (e.key === 'Home') next = tabList[0];
            else if (e.key === 'End') next = tabList[tabList.length - 1];
            if (!next) return;
            e.preventDefault();
            switchToTab(next.dataset.tab);
            next.focus();
        });
    });

    navBtns.forEach((btn) => {
        btn.addEventListener('click', () => switchToTab(btn.dataset.tab));
    });

    // Global Ctrl+V / Cmd+V file paste routed to active workspace
    document.addEventListener('paste', (e) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length === 0) return;

        e.preventDefault();
        if (activeTab === 'security') {
            securityWs.handleFiles(files);
        } else if (activeTab === 'organizer') {
            organizerWs.handleFiles(files);
        } else {
            editorWs.handleFiles(files);
        }
    });

    switchToTab('security');
}

document.addEventListener('DOMContentLoaded', initApp);
