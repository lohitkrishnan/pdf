import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { deliverFile } from './mobile.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

export { pdfjsLib };

// iPhones and iPads (every browser there uses WebKit) refuse to create canvases above about
// 16.7 million pixels and return blank ones instead. Other browsers manage far more.
export const IS_IOS = typeof navigator !== 'undefined'
    && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const MAX_CANVAS_PIXELS = IS_IOS ? 16_000_000 : 40_000_000;

/** Largest scale ≤ `scale` at which a w × h (at scale 1) drawing stays within MAX_CANVAS_PIXELS. */
export function capScale(w, h, scale) {
    return Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, w * h)));
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
        value /= 1024;
        idx += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[idx]}`;
}

export function formatDeltaPct(originalSize, newSize) {
    if (!originalSize || originalSize <= 0) return '0%';
    const diff = originalSize - newSize;
    const pct = (diff / originalSize) * 100;
    if (Math.abs(pct) < 0.05) return '0%';
    if (pct > 0) return `-${pct.toFixed(1)}%`;
    return `+${Math.abs(pct).toFixed(1)}%`;
}

export function applySuffix(filename, suffix) {
    const clean = filename || 'document.pdf';
    // Only a trailing ".pdf" is treated as the extension; other dots ("report.v2") are part of the name.
    const base = clean.toLowerCase().endsWith('.pdf') ? clean.slice(0, -4) : clean;
    return `${base || 'document'}${suffix || ''}.pdf`;
}

export function stripPdfExtension(filename) {
    return (filename || 'document').replace(/\.pdf$/i, '');
}

export function downloadBlob(bytes, filename, mimeType = 'application/pdf') {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mimeType });
    deliverFile(blob, filename); // phones get a Share / Save sheet; desktops download directly
}

export async function readFileBytes(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
}

/**
 * Parse expressions like "1-3, 5, 8-10" into ordered, deduplicated 1-based page numbers.
 */
export function parsePageRange(expr, maxPages) {
    const trimmed = (expr || '').trim();
    if (!trimmed) {
        throw new Error('Enter a page range such as "1-3, 5".');
    }
    if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new Error('No pages available to extract.');
    }

    const result = [];
    const seen = new Set();
    const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);

    if (parts.length === 0) {
        throw new Error('Enter a valid page range such as "1-3, 5".');
    }

    for (const part of parts) {
        const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
        if (rangeMatch) {
            const start = Number.parseInt(rangeMatch[1], 10);
            const end = Number.parseInt(rangeMatch[2], 10);
            if (start < 1 || end < 1 || start > maxPages || end > maxPages) {
                throw new Error(`Range "${part}" is outside 1–${maxPages}.`);
            }
            if (start > end) {
                throw new Error(`Range "${part}" has start greater than end.`);
            }
            for (let p = start; p <= end; p++) {
                if (!seen.has(p)) {
                    seen.add(p);
                    result.push(p);
                }
            }
            continue;
        }

        const singleMatch = /^(\d+)$/.exec(part);
        if (singleMatch) {
            const page = Number.parseInt(singleMatch[1], 10);
            if (page < 1 || page > maxPages) {
                throw new Error(`Page ${page} is outside 1–${maxPages}.`);
            }
            if (!seen.has(page)) {
                seen.add(page);
                result.push(page);
            }
            continue;
        }

        throw new Error(`Invalid range token "${part}". Use numbers and hyphens like "1-3, 5".`);
    }

    return result;
}

/**
 * Render each page at the target DPI and assemble into a JPEG-compressed PDF via jsPDF.
 */
export async function rasterDownsamplePdf(pdfBytes, dpi = 150, jpegQuality = 0.82, password = '') {
    const loadingTask = pdfjsLib.getDocument({
        data: pdfBytes.slice(0),
        ...(password ? { password } : {}),
    });
    const pdf = await loadingTask.promise;
    const { jsPDF } = window.jspdf;

    let doc = null;
    const scale = dpi / 72;

    try {
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const baseVp = page.getViewport({ scale: 1 });
            const renderVp = page.getViewport({ scale: capScale(baseVp.width, baseVp.height, scale) });

            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(renderVp.width));
            canvas.height = Math.max(1, Math.round(renderVp.height));

            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            await page.render({ canvasContext: ctx, viewport: renderVp }).promise;
            const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);

            const orientation = baseVp.width > baseVp.height ? 'l' : 'p';
            if (!doc) {
                doc = new jsPDF({
                    unit: 'pt',
                    format: [baseVp.width, baseVp.height],
                    orientation,
                    compress: true,
                });
            } else {
                doc.addPage([baseVp.width, baseVp.height], orientation);
            }

            doc.addImage(dataUrl, 'JPEG', 0, 0, baseVp.width, baseVp.height, undefined, 'FAST');
            page.cleanup();
        }
    } finally {
        await pdf.destroy();
    }

    return new Uint8Array(doc.output('arraybuffer'));
}

/**
 * Convert a .png, .jpg, .jpeg, or .webp File/Blob into a single-page A4 PDF Uint8Array.
 */
export async function imageFileToPdfBytes(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error(`Could not decode image "${file.name}".`));
            el.src = objectUrl;
        });

        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) {
            throw new Error(`Image "${file.name}" has zero dimensions.`);
        }

        const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!isPng) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);

        const format = isPng ? 'PNG' : 'JPEG';
        const dataUrl = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);

        const A4_SHORT = 595.28;
        const A4_LONG = 841.89;
        const landscape = w > h;
        const pageW = landscape ? A4_LONG : A4_SHORT;
        const pageH = landscape ? A4_SHORT : A4_LONG;
        const margin = 18;
        const maxW = pageW - margin * 2;
        const maxH = pageH - margin * 2;
        const ratio = Math.min(maxW / w, maxH / h);
        const drawW = w * ratio;
        const drawH = h * ratio;
        const drawX = (pageW - drawW) / 2;
        const drawY = (pageH - drawH) / 2;

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({
            unit: 'pt',
            format: [pageW, pageH],
            orientation: landscape ? 'l' : 'p',
            compress: true,
        });
        doc.addImage(dataUrl, format, drawX, drawY, drawW, drawH, undefined, 'FAST');

        return new Uint8Array(doc.output('arraybuffer'));
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

export function isPdfFile(file) {
    return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

export function isImageFile(file) {
    return file && (
        /^image\/(png|jpeg|jpg|webp)$/i.test(file.type || '') ||
        /\.(png|jpe?g|webp)$/i.test(file.name || '')
    );
}
