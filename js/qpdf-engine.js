import { rasterDownsamplePdf } from './pdf-utils.js';

const WASM_URL = new URL('../vendor/qpdf.wasm', import.meta.url).href;
let cachedWasmBuffer = null;

async function getWasmBuffer() {
    if (!cachedWasmBuffer) {
        const res = await fetch(WASM_URL);
        if (!res.ok) {
            throw new Error(`Failed to fetch qpdf.wasm (${res.status})`);
        }
        cachedWasmBuffer = await res.arrayBuffer();
    }
    return cachedWasmBuffer;
}

/**
 * Execute QPDF 12.2.0 WASM in a fresh Emscripten instance to guarantee isolated FS/state.
 */
async function runQpdf(args, inputBytes = null, readOutputPath = null) {
    if (typeof window.Module !== 'function') {
        throw new Error('QPDF WASM loader (vendor/qpdf.js) is not available.');
    }

    const wasmBuf = await getWasmBuffer();
    const stdout = [];
    const stderr = [];

    // This QPDF build ignores Module.print/printErr and binds console.log/console.error
    // synchronously when the factory runs. Swap the console methods for that synchronous
    // window only, so this instance writes into our buffers instead of the browser console.
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...parts) => stdout.push(parts.map(String).join(' '));
    console.error = (...parts) => stderr.push(parts.map(String).join(' '));
    let qpdfPromise;
    try {
        qpdfPromise = window.Module({
            wasmBinary: wasmBuf.slice(0),
            print: (line) => stdout.push(String(line)),
            printErr: (line) => stderr.push(String(line)),
        });
    } finally {
        console.log = origLog;
        console.error = origErr;
    }
    const qpdf = await qpdfPromise;

    if (inputBytes) {
        qpdf.FS.writeFile('/in.pdf', inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes));
    }

    let exitCode = 0;
    try {
        const ret = qpdf.callMain(args);
        if (typeof ret === 'number') exitCode = ret;
    } catch (err) {
        if (err && typeof err.status === 'number') {
            exitCode = err.status;
        } else {
            throw err;
        }
    }

    let outputBytes = null;
    if (readOutputPath) {
        try {
            const raw = qpdf.FS.readFile(readOutputPath);
            outputBytes = new Uint8Array(raw);
        } catch {
            outputBytes = null;
        }
    }

    return {
        exitCode,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
        outputBytes,
    };
}

// PDF readers accept the %PDF- header anywhere in the first 1024 bytes.
function hasPdfHeader(bytes) {
    const n = Math.min(bytes.byteLength, 1024);
    for (let i = 0; i + 4 < n; i++) {
        if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
            return true;
        }
    }
    return false;
}

function cleanQpdfError(text) {
    const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    // QPDF prefixes messages with the program name and the virtual input path.
    return first.replace(/^(\.\/)?this\.program:\s*/, '').replace(/^\/in\.pdf(\s*\([^)]*\))?:\s*/, '');
}

function parsePdfHeaderVersion(bytes) {
    const slice = bytes.subarray(0, Math.min(64, bytes.length));
    let header = '';
    for (let i = 0; i < slice.length; i++) {
        header += String.fromCharCode(slice[i]);
    }
    const match = /%PDF-(\d+\.\d+)/.exec(header);
    return match ? match[1] : '1.x';
}

function parseEncryptionDetails(stdout) {
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const cipherLine = lines.find((l) => /\b(AES|RC4|256-bit|128-bit|40-bit|R\s*=)/i.test(l));
    const permLines = lines.filter((l) => /^(printing|modify|extract|annotate|assemble|form|stream|string|R =)/i.test(l));
    const parts = [];
    if (cipherLine) parts.push(cipherLine);
    if (permLines.length > 0) parts.push(permLines.slice(0, 3).join(' · '));
    return parts.join(' | ') || lines.slice(0, 3).join(' · ');
}

function parsePageCount(stdout) {
    const match = /(\d+)/.exec((stdout || '').trim());
    return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Inspect PDF version, page count, byte size, and encryption state.
 */
export async function inspectPdf(bytes, password = '') {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const version = parsePdfHeaderVersion(data);

    // First probe without password to classify intrinsic lock state accurately
    const baseProbe = await runQpdf(['--show-encryption', '/in.pdf'], data);

    let encryptionState = 'unencrypted';
    let details = '';
    let unlockedWithPassword = '';

    if (!hasPdfHeader(data)) {
        encryptionState = 'invalid';
        details = data.byteLength === 0 ? 'File is empty' : 'Not a PDF file';
    } else if (/File is not encrypted/i.test(baseProbe.stdout)) {
        encryptionState = 'unencrypted';
        details = 'No password or permission restrictions';
    } else if (baseProbe.exitCode === 0 || baseProbe.exitCode === 3) {
        encryptionState = 'permissions_locked';
        details = parseEncryptionDetails(baseProbe.stdout) || 'Owner permissions set (opens without password)';
    } else if (/invalid password/i.test(baseProbe.stderr)) {
        encryptionState = 'password_required';
        details = 'User open password required';
    } else {
        // QPDF could not open the file for a reason other than a password: it is damaged.
        encryptionState = 'invalid';
        const reason = cleanQpdfError(baseProbe.stderr);
        details = reason ? `Damaged PDF (${reason})` : 'PDF is damaged and could not be read';
    }

    let canReadPages = encryptionState === 'unencrypted' || encryptionState === 'permissions_locked';
    let effectivePassword = '';

    if (encryptionState === 'password_required' && password) {
        const pwProbe = await runQpdf(['--show-encryption', `--password=${password}`, '/in.pdf'], data);
        if (pwProbe.exitCode === 0 || pwProbe.exitCode === 3) {
            canReadPages = true;
            effectivePassword = password;
            unlockedWithPassword = password;
            details = parseEncryptionDetails(pwProbe.stdout) || 'Unlocked with provided password';
        }
    }

    let pageCount = null;
    if (canReadPages) {
        const npArgs = ['--show-npages', ...(effectivePassword ? [`--password=${effectivePassword}`] : []), '/in.pdf'];
        const npRes = await runQpdf(npArgs, data);
        if (npRes.exitCode === 0 || npRes.exitCode === 3) {
            pageCount = parsePageCount(npRes.stdout);
        }
        if (!pageCount) {
            try {
                const doc = await window.PDFLib.PDFDocument.load(data, { ignoreEncryption: true });
                pageCount = doc.getPageCount();
            } catch {
                pageCount = null;
            }
        }
    }

    return {
        version,
        pageCount,
        size: data.byteLength,
        encryptionState, // 'unencrypted' | 'permissions_locked' | 'password_required' | 'invalid'
        details,
        unlockedWithPassword,
    };
}

/**
 * Unlock / decrypt a PDF and optionally apply Lossless (QPDF L9), Balanced (150 DPI), or Maximum (96 DPI) compression.
 */
export async function unlockAndCompress(bytes, opts = {}) {
    return (await unlockAndCompressDetailed(bytes, opts)).bytes;
}

const LOSSLESS_ARGS = [
    '--compress-streams=y',
    '--recompress-flate',
    '--compression-level=9',
    '--object-streams=generate',
    '--optimize-images',
];

/**
 * Same as unlockAndCompress, but also returns a short note when the requested mode was
 * not the one that produced the output (e.g. raster made the file bigger, so the
 * lossless vector result was kept instead).
 */
export async function unlockAndCompressDetailed(bytes, { password = '', compression = 'off' } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const pwArgs = password ? [`--password=${password}`] : [];
    const isRaster = compression === 'balanced' || compression === 'maximum';

    // Step 1: Decrypt / normalize. Lossless flags are applied for 'lossless', and also for the
    // raster modes so there is a vector baseline to compare the raster result against.
    const qpdfArgs = ['--decrypt', ...pwArgs];
    if (compression === 'lossless' || isRaster) {
        qpdfArgs.push(...LOSSLESS_ARGS);
    }
    qpdfArgs.push('/in.pdf', '/out.pdf');

    const res = await runQpdf(qpdfArgs, data, '/out.pdf');
    if ((res.exitCode !== 0 && res.exitCode !== 3) || !res.outputBytes) {
        const errText = res.stderr || res.stdout || `QPDF exited with code ${res.exitCode}`;
        if (/invalid password/i.test(errText)) {
            const err = new Error(
                password
                    ? 'Wrong password for this PDF. Check the master password or set a per-file override.'
                    : 'This PDF needs its open password. Enter it above or as a per-file override.'
            );
            err.code = 'INVALID_PASSWORD';
            throw err;
        }
        throw new Error(cleanQpdfError(errText) || 'Failed to process PDF with QPDF.');
    }

    if (!isRaster) {
        return keepOriginalIfSmaller(data, res.outputBytes, compression, '');
    }

    // Step 2: Raster downsample for Balanced (150 DPI) or Maximum (96 DPI)
    const vectorBytes = res.outputBytes;
    const dpi = compression === 'balanced' ? 150 : 96;
    const quality = compression === 'balanced' ? 0.82 : 0.68;
    let rasterBytes = await rasterDownsamplePdf(vectorBytes, dpi, quality);

    // Run lossless QPDF object-stream cleanup on the raster output and keep whichever is smaller
    const optRes = await runQpdf(
        [
            '--compress-streams=y',
            '--recompress-flate',
            '--compression-level=9',
            '--object-streams=generate',
            '/in.pdf',
            '/out.pdf',
        ],
        rasterBytes,
        '/out.pdf'
    );
    if ((optRes.exitCode === 0 || optRes.exitCode === 3) && optRes.outputBytes && optRes.outputBytes.byteLength < rasterBytes.byteLength) {
        rasterBytes = optRes.outputBytes;
    }

    // Rasterizing text/vector PDFs often makes them bigger and loses selectable text.
    // Only keep the raster version when it actually saves space.
    if (rasterBytes.byteLength >= vectorBytes.byteLength) {
        return keepOriginalIfSmaller(
            data,
            vectorBytes,
            compression,
            `${dpi} DPI raster would have been larger (${Math.round(rasterBytes.byteLength / 1024)} KB), so the lossless vector version was kept.`
        );
    }
    return { bytes: rasterBytes, note: '' };
}

/**
 * Compression should never make an already-compact file bigger. If the processed output is
 * larger than the input and the input was not encrypted (so there is nothing to unlock),
 * hand back the original bytes unchanged.
 */
async function keepOriginalIfSmaller(original, processed, compression, note) {
    if (compression === 'off' || processed.byteLength < original.byteLength) {
        return { bytes: processed, note };
    }
    const probe = await runQpdf(['--show-encryption', '/in.pdf'], original);
    if (/File is not encrypted/i.test(probe.stdout)) {
        return { bytes: original, note: 'Already compact: compressing would not make it smaller, so the original was kept unchanged.' };
    }
    return { bytes: processed, note };
}

/**
 * Lock / encrypt a PDF with User/Owner passwords, 256-bit AES R6 or 128-bit AES R4, and granular permissions.
 */
export async function lockPdf(
    bytes,
    {
        inputPassword = '',
        userPassword = '',
        ownerPassword = '',
        cipher = '256',
        print = 'full',
        modify = 'all',
        extract = 'y',
        compression = 'off',
    } = {}
) {
    if (!userPassword && !ownerPassword) {
        throw new Error('Provide at least a User (open) password or an Owner (permissions) password.');
    }

    let workingBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let workingPw = inputPassword;

    if (compression === 'balanced' || compression === 'maximum') {
        workingBytes = await unlockAndCompress(workingBytes, { password: inputPassword, compression });
        workingPw = '';
    }

    const effectiveOwner = ownerPassword || userPassword;
    const args = [];

    if (workingPw) {
        args.push(`--password=${workingPw}`);
    }

    if (compression === 'lossless') {
        args.push(
            '--compress-streams=y',
            '--recompress-flate',
            '--compression-level=9',
            '--object-streams=generate',
            '--optimize-images'
        );
    }

    // Use the named forms: positional passwords starting with "-" are parsed as options by QPDF.
    args.push(
        '--encrypt',
        `--user-password=${userPassword}`,
        `--owner-password=${effectiveOwner}`,
        `--bits=${cipher === '128' ? '128' : '256'}`
    );
    if (cipher === '128') {
        args.push('--use-aes=y');
    }
    args.push(`--print=${print}`, `--modify=${modify}`, `--extract=${extract}`, '--', '/in.pdf', '/out.pdf');

    const res = await runQpdf(args, workingBytes, '/out.pdf');
    if ((res.exitCode !== 0 && res.exitCode !== 3) || !res.outputBytes) {
        const errText = res.stderr || res.stdout || `QPDF exited with code ${res.exitCode}`;
        if (/invalid password/i.test(errText)) {
            const err = new Error('Source PDF requires a valid open password before locking.');
            err.code = 'INVALID_PASSWORD';
            throw err;
        }
        throw new Error(cleanQpdfError(errText) || 'Failed to encrypt PDF.');
    }

    return res.outputBytes;
}

/**
 * Transparently unlock unencrypted or owner-locked PDFs; throw PASSWORD_REQUIRED if user password needed.
 */
export async function ensureUnlocked(bytes, password = '') {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const info = await inspectPdf(data, password);

    if (info.encryptionState === 'unencrypted') {
        return data;
    }

    if (info.encryptionState === 'invalid') {
        const err = new Error(`Can't open this file: ${info.details}.`);
        err.code = 'INVALID_PDF';
        throw err;
    }

    if (info.encryptionState === 'password_required' && !info.unlockedWithPassword) {
        const err = new Error('This PDF requires an open password.');
        err.code = 'PASSWORD_REQUIRED';
        throw err;
    }

    return unlockAndCompress(data, { password: info.unlockedWithPassword || password, compression: 'off' });
}
