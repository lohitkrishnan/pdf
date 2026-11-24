// Zero-dependency binary PKZIP writer using STORE (method 0), CRC-32, and UTF-8 filenames.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
        ((date.getHours() & 0x1f) << 11) |
        ((date.getMinutes() & 0x3f) << 5) |
        ((date.getSeconds() >> 1) & 0x1f);
    const dosDate =
        (((year - 1980) & 0x7f) << 9) |
        (((date.getMonth() + 1) & 0x0f) << 5) |
        (date.getDate() & 0x1f);
    return { dosTime, dosDate };
}

function deduplicateName(rawName, seen) {
    const clean = rawName.replace(/^\/+/, '') || 'file.pdf';
    if (!seen.has(clean)) {
        seen.add(clean);
        return clean;
    }
    const dot = clean.lastIndexOf('.');
    const base = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : '';
    let counter = 2;
    let candidate = `${base}_${counter}${ext}`;
    while (seen.has(candidate)) {
        counter += 1;
        candidate = `${base}_${counter}${ext}`;
    }
    seen.add(candidate);
    return candidate;
}

/**
 * Package an array of { name, data } entries into a valid ZIP archive Uint8Array.
 * Uses STORE (method 0) since PDFs are already internally compressed.
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Uint8Array}
 */
// This writer produces classic (non-Zip64) archives: at most 65,535 entries and 4 GiB in total.
const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_BYTES = 0xffffffff;

export function createZip(entries) {
    if (entries.length > ZIP_MAX_ENTRIES) {
        throw new Error(`Too many files for one .zip (${entries.length}; the limit is ${ZIP_MAX_ENTRIES}). Split into larger chunks.`);
    }
    const totalBytes = entries.reduce((sum, e) => sum + (e.data?.byteLength || 0), 0);
    // Rough bound including headers; keeps every offset within 32 bits.
    if (totalBytes + entries.length * 1024 > ZIP_MAX_BYTES) {
        throw new Error('These files are too large to put in one .zip (4 GiB limit).');
    }
    const encoder = new TextEncoder();
    const { dosTime, dosDate } = dosTimeDate();
    const seenNames = new Set();

    const localParts = [];
    const centralRecords = [];
    let offset = 0;

    for (const entry of entries) {
        const name = deduplicateName(entry.name, seenNames);
        const nameBytes = encoder.encode(name);
        const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
        const crc = crc32(data);
        const size = data.byteLength;

        const localHeader = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true); // Local file header signature
        lv.setUint16(4, 20, true);         // Version needed to extract (2.0)
        lv.setUint16(6, 0x0800, true);     // General purpose bit flag (UTF-8 filename)
        lv.setUint16(8, 0, true);          // Compression method: 0 (STORE)
        lv.setUint16(10, dosTime, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true);      // Compressed size
        lv.setUint32(22, size, true);      // Uncompressed size
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);         // Extra field length
        localHeader.set(nameBytes, 30);

        localParts.push(localHeader, data);

        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(centralHeader.buffer);
        cv.setUint32(0, 0x02014b50, true); // Central file header signature
        cv.setUint16(4, 20, true);         // Version made by
        cv.setUint16(6, 20, true);         // Version needed to extract
        cv.setUint16(8, 0x0800, true);     // UTF-8 filename flag
        cv.setUint16(10, 0, true);         // Compression method: 0 (STORE)
        cv.setUint16(12, dosTime, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);      // Compressed size
        cv.setUint32(24, size, true);      // Uncompressed size
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);         // Extra field length
        cv.setUint16(32, 0, true);         // File comment length
        cv.setUint16(34, 0, true);         // Disk number start
        cv.setUint16(36, 0, true);         // Internal file attributes
        cv.setUint32(38, 0, true);         // External file attributes
        cv.setUint32(42, offset, true);    // Relative offset of local header
        centralHeader.set(nameBytes, 46);

        centralRecords.push(centralHeader);
        offset += localHeader.length + size;
    }

    const centralDirOffset = offset;
    let centralDirSize = 0;
    for (const rec of centralRecords) {
        centralDirSize += rec.length;
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);            // EOCD signature
    ev.setUint16(4, 0, true);                     // Number of this disk
    ev.setUint16(6, 0, true);                     // Disk where central directory starts
    ev.setUint16(8, centralRecords.length, true); // Entries on this disk
    ev.setUint16(10, centralRecords.length, true);// Total entries
    ev.setUint32(12, centralDirSize, true);       // Size of central directory
    ev.setUint32(16, centralDirOffset, true);     // Offset of central directory
    ev.setUint16(20, 0, true);                    // ZIP file comment length

    const totalSize = offset + centralDirSize + eocd.length;
    const output = new Uint8Array(totalSize);
    let cursor = 0;

    for (const part of localParts) {
        output.set(part, cursor);
        cursor += part.length;
    }
    for (const rec of centralRecords) {
        output.set(rec, cursor);
        cursor += rec.length;
    }
    output.set(eocd, cursor);

    return output;
}
