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

    const qpdf = await window.Module({
        wasmBinary: wasmBuf.slice(0),
        print: (line) => stdout.push(String(line)),
        printErr: (line) => stderr.push(String(line)),
    });

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

    if (/File is not encrypted/i.test(baseProbe.stdout)) {
        encryptionState = 'unencrypted';
        details = 'No password or permission restrictions';
    } else if (baseProbe.exitCode === 0 || baseProbe.exitCode === 3) {
        encryptionState = 'permissions_locked';
        details = parseEncryptionDetails(baseProbe.stdout) || 'Owner permissions set (opens without password)';
    } else {
        encryptionState = 'password_required';
        details = 'User open password required';
    }

    let canReadPages = encryptionState !== 'password_required';
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
        encryptionState, // 'unencrypted' | 'permissions_locked' | 'password_required'
        details,
        unlockedWithPassword,
    };
}

/**
 * Unlock / decrypt a PDF and optionally apply Lossless (QPDF L9), Balanced (150 DPI), or Maximum (96 DPI) compression.
 */
export async function unlockAndCompress(bytes, { password = '', compression = 'off' } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const pwArgs = password ? [`--password=${password}`] : [];

    // Step 1: Decrypt / normalize (and apply lossless QPDF flags if compression === 'lossless')
    const qpdfArgs = ['--decrypt', ...pwArgs];
    if (compression === 'lossless') {
        qpdfArgs.push(
            '--compress-streams=y',
            '--recompress-flate',
            '--compression-level=9',
            '--object-streams=generate',
            '--optimize-images'
        );
    }
    qpdfArgs.push('/in.pdf', '/out.pdf');

    const res = await runQpdf(qpdfArgs, data, '/out.pdf');
    if ((res.exitCode !== 0 && res.exitCode !== 3) || !res.outputBytes) {
        const errText = res.stderr || res.stdout || `QPDF exited with code ${res.exitCode}`;
        if (/invalid password/i.test(errText)) {
            const err = new Error('Invalid password for this PDF.');
            err.code = 'INVALID_PASSWORD';
            throw err;
        }
        throw new Error(errText.split('\n')[0] || 'Failed to process PDF with QPDF.');
    }

    let finalBytes = res.outputBytes;

    // Step 2: Raster downsample if Balanced (150 DPI) or Maximum (96 DPI)
    if (compression === 'balanced' || compression === 'maximum') {
        const dpi = compression === 'balanced' ? 150 : 96;
        const quality = compression === 'balanced' ? 0.82 : 0.68;
        const rasterBytes = await rasterDownsamplePdf(finalBytes, dpi, quality);

        // Run lossless QPDF object-stream cleanup and keep whichever is smaller
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
            finalBytes = optRes.outputBytes;
        } else {
            finalBytes = rasterBytes;
        }
    }

    return finalBytes;
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

    args.push('--encrypt', userPassword, effectiveOwner, cipher === '128' ? '128' : '256');
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
        throw new Error(errText.split('\n')[0] || 'Failed to encrypt PDF.');
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

    if (info.encryptionState === 'password_required' && !info.unlockedWithPassword) {
        const err = new Error('This PDF requires an open password.');
        err.code = 'PASSWORD_REQUIRED';
        throw err;
    }

    return unlockAndCompress(data, { password: info.unlockedWithPassword || password, compression: 'off' });
}
