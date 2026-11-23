import { lockPdf } from './qpdf-engine.js';

/**
 * Sample 1 (Workspace 1): 2-page encrypted Compensation & Tax Summary (password: secret123).
 */
export async function createEncryptedSample() {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const sans = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const p1 = doc.addPage([595.28, 841.89]);
    p1.drawRectangle({ x: 42, y: 742, width: 511, height: 60, color: rgb(0.96, 0.93, 0.88) });
    p1.drawText('FY 2026-27 COMPENSATION & TAX SUMMARY', {
        x: 56, y: 774, size: 17, font: bold, color: rgb(0.14, 0.13, 0.12),
    });
    p1.drawText('Sample Password-Protected Document (Open password: secret123)', {
        x: 56, y: 753, size: 10.5, font: sans, color: rgb(0.43, 0.41, 0.38),
    });

    const rows = [
        ['Employee Name', 'Aarav Mehta'],
        ['Employee ID', 'BLR-ENG-4092'],
        ['Tax Identifier', 'ABCDE1234F'],
        ['Base Compensation', 'INR 36,00,000'],
        ['Variable Bonus', 'INR 4,50,000'],
        ['Withheld TDS', 'INR 8,42,000'],
        ['Document Status', 'AES-256 Protected · Low-Res Print Only'],
    ];
    let y = 696;
    for (const [k, v] of rows) {
        p1.drawLine({ start: { x: 48, y: y - 10 }, end: { x: 546, y: y - 10 }, thickness: 0.6, color: rgb(0.88, 0.85, 0.8) });
        p1.drawText(k, { x: 54, y, size: 11, font: bold, color: rgb(0.3, 0.28, 0.25) });
        p1.drawText(v, { x: 250, y, size: 11, font: sans, color: rgb(0.14, 0.13, 0.12) });
        y -= 32;
    }

    p1.drawText('Note: Unlock this sample in Workspace 1 with password "secret123", test lossless or DPI compression,', {
        x: 54, y: 420, size: 10.5, font: sans, color: rgb(0.35, 0.33, 0.3),
    });
    p1.drawText('or hand the unlocked PDF straight into Merge / Split or Edit / Fill / Sign.', {
        x: 54, y: 403, size: 10.5, font: sans, color: rgb(0.35, 0.33, 0.3),
    });

    const p2 = doc.addPage([595.28, 841.89]);
    p2.drawText('Page 2 — Schedule of Deductions & Declarations', {
        x: 54, y: 775, size: 15, font: bold, color: rgb(0.14, 0.13, 0.12),
    });
    p2.drawRectangle({ x: 54, y: 540, width: 488, height: 210, color: rgb(0.98, 0.97, 0.94), borderColor: rgb(0.84, 0.81, 0.76), borderWidth: 1 });
    p2.drawText('Section 80C Investments: INR 1,50,000', { x: 74, y: 710, size: 11.5, font: sans, color: rgb(0.16, 0.15, 0.14) });
    p2.drawText('Health Insurance (80D): INR 25,000', { x: 74, y: 680, size: 11.5, font: sans, color: rgb(0.16, 0.15, 0.14) });
    p2.drawText('HRA Exemption Verified: INR 3,12,000', { x: 74, y: 650, size: 11.5, font: sans, color: rgb(0.16, 0.15, 0.14) });
    p2.drawText('Employer Verification Code: KRN-2026-8841', { x: 74, y: 600, size: 11.5, font: bold, color: rgb(0.75, 0.4, 0.0) });

    const rawBytes = await doc.save();
    const encryptedBytes = await lockPdf(rawBytes, {
        userPassword: 'secret123',
        ownerPassword: 'owner_admin',
        cipher: '256',
        print: 'low',
        modify: 'none',
        extract: 'n',
    });

    return {
        name: 'compensation_tax_summary_locked.pdf',
        bytes: encryptedBytes,
    };
}

/**
 * Sample 2 (Workspace 2): Two distinct multi-page PDFs (3 pages + 2 pages) for visual Merge/Split testing.
 */
export async function createOrganizerSamples() {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

    async function buildDoc(title, subtitle, pages, accentRgb) {
        const doc = await PDFDocument.create();
        const sans = await doc.embedFont(StandardFonts.Helvetica);
        const bold = await doc.embedFont(StandardFonts.HelveticaBold);

        for (let i = 0; i < pages.length; i++) {
            const p = doc.addPage([595.28, 841.89]);
            p.drawRectangle({ x: 0, y: 760, width: 595.28, height: 82, color: accentRgb });
            p.drawText(title, { x: 46, y: 804, size: 17, font: bold, color: rgb(1, 1, 1) });
            p.drawText(`${subtitle} · Page ${i + 1} of ${pages.length}`, {
                x: 46, y: 781, size: 10.5, font: sans, color: rgb(0.95, 0.95, 0.95),
            });

            p.drawRectangle({
                x: 46, y: 470, width: 503, height: 250,
                color: rgb(0.97, 0.96, 0.94),
                borderColor: accentRgb,
                borderWidth: 2,
            });
            p.drawText(`0${i + 1}`, { x: 70, y: 635, size: 64, font: bold, color: accentRgb });
            p.drawText(pages[i].heading, { x: 70, y: 585, size: 20, font: bold, color: rgb(0.14, 0.13, 0.12) });
            p.drawText(pages[i].body, { x: 70, y: 550, size: 12, font: sans, color: rgb(0.32, 0.3, 0.27), maxWidth: 455 });

            p.drawText('Drag thumbnails to reorder, rotate 90°, duplicate, extract ranges, or burst to .zip.', {
                x: 46, y: 410, size: 10.5, font: sans, color: rgb(0.45, 0.43, 0.4),
            });
        }
        return doc.save();
    }

    const doc1Bytes = await buildDoc(
        'Product Architecture Brief',
        'product_architecture_3p.pdf',
        [
            { heading: 'System Overview & Privacy Guarantee', body: 'All PDF parsing, encryption, page assembly, and redaction execute locally inside WebAssembly and Canvas workers.' },
            { heading: 'QPDF WASM Pipeline', body: 'Handles AES-256 R6 / AES-128 R4 encryption, permission flags, object streams, and Flate level 9 recompression.' },
            { heading: 'Visual Canvas & Form Engine', body: 'Combines PDF.js HiDPI rendering with pdf-lib vector modifications and 200 DPI burn-in sanitization.' },
        ],
        rgb(0.84, 0.45, 0.02)
    );

    const doc2Bytes = await buildDoc(
        'Q4 Financial Appendix',
        'q4_financial_appendix_2p.pdf',
        [
            { heading: 'Quarterly Infrastructure Cost: $0', body: 'Static hosting via GitHub Pages eliminates server-side CPU, storage, and upload bandwidth costs.' },
            { heading: 'Audit & Compliance Checklist', body: 'Zero bytes transmitted over the network; verified offline capability once loaded.' },
        ],
        rgb(0.16, 0.32, 0.46)
    );

    return [
        { name: 'product_architecture_3p.pdf', bytes: new Uint8Array(doc1Bytes) },
        { name: 'q4_financial_appendix_2p.pdf', bytes: new Uint8Array(doc2Bytes) },
    ];
}

/**
 * Sample 3 (Workspace 3): 2-page interactive AcroForm Mutual NDA.
 */
export async function createFillableNdaSample() {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const form = doc.getForm();
    const sans = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const serif = await doc.embedFont(StandardFonts.TimesRoman);

    const p1 = doc.addPage([595.28, 841.89]);
    p1.drawText('MUTUAL NON-DISCLOSURE AGREEMENT (FILLABLE SAMPLE)', {
        x: 50, y: 782, size: 15, font: bold, color: rgb(0.14, 0.13, 0.12),
    });
    p1.drawLine({ start: { x: 50, y: 772 }, end: { x: 545, y: 772 }, thickness: 1.5, color: rgb(0.88, 0.48, 0.0) });

    p1.drawText('This Mutual Non-Disclosure Agreement ("Agreement") is entered into as of the Effective Date below', {
        x: 50, y: 742, size: 10.5, font: serif, color: rgb(0.2, 0.19, 0.17),
    });
    p1.drawText('between Lohit Krishnan Studio and the Recipient identified in the interactive fields below.', {
        x: 50, y: 726, size: 10.5, font: serif, color: rgb(0.2, 0.19, 0.17),
    });

    const addTextField = (page, label, name, x, y, width, defaultVal = '') => {
        page.drawText(label, { x, y: y + 26, size: 10, font: bold, color: rgb(0.25, 0.23, 0.21) });
        const field = form.createTextField(name);
        if (defaultVal) field.setText(defaultVal);
        field.addToPage(page, {
            x, y, width, height: 22,
            borderWidth: 1,
            borderColor: rgb(0.65, 0.62, 0.58),
            backgroundColor: rgb(0.98, 0.97, 0.95),
        });
    };

    addTextField(p1, 'Recipient Full Name', 'Recipient_Name', 50, 650, 230, 'Rohan Deshmukh');
    addTextField(p1, 'Organization / Company', 'Organization', 310, 650, 235, 'Northstar Labs Pvt Ltd');
    addTextField(p1, 'Role / Title', 'Role_Title', 50, 588, 230, 'Principal Engineer');
    addTextField(p1, 'Effective Date (YYYY-MM-DD)', 'Effective_Date', 310, 588, 235, '2026-11-19');

    p1.drawText('Governing Jurisdiction', { x: 50, y: 552, size: 10, font: bold, color: rgb(0.25, 0.23, 0.21) });
    const dropdown = form.createDropdown('Jurisdiction');
    dropdown.addOptions(['Bengaluru, Karnataka', 'San Francisco, CA', 'New York, NY', 'Singapore']);
    dropdown.select('Bengaluru, Karnataka');
    dropdown.addToPage(p1, {
        x: 50, y: 526, width: 230, height: 22,
        borderWidth: 1,
        borderColor: rgb(0.65, 0.62, 0.58),
        backgroundColor: rgb(0.98, 0.97, 0.95),
    });

    const cb1 = form.createCheckBox('Mutual_Disclosure');
    cb1.check();
    cb1.addToPage(p1, { x: 50, y: 472, width: 16, height: 16, borderWidth: 1, borderColor: rgb(0.45, 0.42, 0.39) });
    p1.drawText('Both parties agree to mutual confidentiality obligations.', {
        x: 74, y: 476, size: 10.5, font: sans, color: rgb(0.18, 0.17, 0.16),
    });

    const cb2 = form.createCheckBox('Three_Year_Survival');
    cb2.addToPage(p1, { x: 50, y: 440, width: 16, height: 16, borderWidth: 1, borderColor: rgb(0.45, 0.42, 0.39) });
    p1.drawText('Confidentiality obligations survive for three (3) years after termination.', {
        x: 74, y: 444, size: 10.5, font: sans, color: rgb(0.18, 0.17, 0.16),
    });

    p1.drawText('1. Definition of Confidential Information. Non-public technical architecture, datasets, and code.', {
        x: 50, y: 380, size: 10, font: serif, color: rgb(0.28, 0.26, 0.24),
    });
    p1.drawText('2. Standard of Care. Each party shall protect Confidential Information using reasonable care.', {
        x: 50, y: 358, size: 10, font: serif, color: rgb(0.28, 0.26, 0.24),
    });

    const p2 = doc.addPage([595.28, 841.89]);
    p2.drawText('EXECUTION & SIGNATURE PAGE', { x: 50, y: 782, size: 14, font: bold, color: rgb(0.14, 0.13, 0.12) });
    p2.drawText('Sign below using the Draw, Type, or Upload Stamp tools in Workspace 3.', {
        x: 50, y: 758, size: 10.5, font: sans, color: rgb(0.43, 0.41, 0.38),
    });

    p2.drawRectangle({
        x: 50, y: 540, width: 495, height: 180,
        color: rgb(0.99, 0.985, 0.97),
        borderColor: rgb(0.75, 0.72, 0.68),
        borderWidth: 1,
    });
    p2.drawText('Recipient Signature:', { x: 70, y: 690, size: 10.5, font: bold, color: rgb(0.24, 0.22, 0.2) });
    p2.drawLine({ start: { x: 70, y: 595 }, end: { x: 340, y: 595 }, thickness: 1, color: rgb(0.4, 0.38, 0.35) });
    p2.drawText('Authorized Signatory', { x: 70, y: 578, size: 9.5, font: sans, color: rgb(0.45, 0.43, 0.4) });

    p2.drawLine({ start: { x: 375, y: 595 }, end: { x: 520, y: 595 }, thickness: 1, color: rgb(0.4, 0.38, 0.35) });
    p2.drawText('Date Signed', { x: 375, y: 578, size: 9.5, font: sans, color: rgb(0.45, 0.43, 0.4) });

    return {
        name: 'mutual_nda_form.pdf',
        bytes: new Uint8Array(await doc.save()),
    };
}

/**
 * Sample 4 (Workspace 4): Rich 2-page Confidential Audit & Consulting Invoice
 * crafted for testing In-Place PDF Text Editing, Whiteout, Verified Stamp, and 200 DPI Burn-In Redaction.
 */
export async function createConfidentialEditableSample() {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const sans = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const serif = await doc.embedFont(StandardFonts.TimesRoman);
    const mono = await doc.embedFont(StandardFonts.Courier);

    const p1 = doc.addPage([595.28, 841.89]);
    p1.drawText('SECURITY AUDIT & CONSULTING INVOICE', {
        x: 48, y: 784, size: 18, font: bold, color: rgb(0.14, 0.13, 0.12),
    });
    p1.drawText('Invoice #INV-2026-104  |  Issue Date: 2026-11-12  |  Due Date: 2026-12-12', {
        x: 48, y: 758, size: 10.5, font: sans, color: rgb(0.38, 0.36, 0.34),
    });
    p1.drawLine({ start: { x: 48, y: 744 }, end: { x: 547, y: 744 }, thickness: 1.5, color: rgb(0.88, 0.48, 0.0) });

    // Client block
    p1.drawText('Billed To: Apex Fintech Systems Pvt. Ltd.', { x: 48, y: 710, size: 11.5, font: bold, color: rgb(0.14, 0.13, 0.12) });
    p1.drawText('Attention: Kavya Nair, VP of Security Engineering', { x: 48, y: 691, size: 10.5, font: serif, color: rgb(0.22, 0.2, 0.18) });
    p1.drawText('Address: 42 Residency Road, Bengaluru 560025', { x: 48, y: 673, size: 10.5, font: serif, color: rgb(0.22, 0.2, 0.18) });

    // Tinted card to showcase background-matched inline text editing!
    p1.drawRectangle({ x: 48, y: 495, width: 499, height: 148, color: rgb(0.95, 0.92, 0.87) });
    p1.drawText('LINE ITEMS (Click any line with "Edit PDF Text" to edit inline)', {
        x: 62, y: 622, size: 10.5, font: bold, color: rgb(0.55, 0.28, 0.0),
    });
    p1.drawText('1. Client-Side WASM Cryptography Review       USD 4,200.00', {
        x: 62, y: 590, size: 11, font: sans, color: rgb(0.14, 0.13, 0.12),
    });
    p1.drawText('2. Threat Modeling & Zero-Upload Verification   USD 2,800.00', {
        x: 62, y: 564, size: 11, font: sans, color: rgb(0.14, 0.13, 0.12),
    });
    p1.drawText('3. Final Remediation Sign-Off & Report          USD 1,500.00', {
        x: 62, y: 538, size: 11, font: sans, color: rgb(0.14, 0.13, 0.12),
    });
    p1.drawText('TOTAL AMOUNT DUE: USD 8,500.00', {
        x: 62, y: 508, size: 12.5, font: bold, color: rgb(0.14, 0.13, 0.12),
    });

    // Confidential Credentials block for Redaction Burn-In testing
    p1.drawRectangle({
        x: 48, y: 318, width: 499, height: 142,
        color: rgb(0.99, 0.96, 0.96),
        borderColor: rgb(0.75, 0.22, 0.22),
        borderWidth: 1,
    });
    p1.drawText('CONFIDENTIAL CREDENTIALS & TAX DETAILS (Redact before sharing)', {
        x: 62, y: 436, size: 10.5, font: bold, color: rgb(0.68, 0.12, 0.12),
    });
    p1.drawText('PAN / Tax ID:       BZPK9041M', { x: 62, y: 406, size: 11, font: mono, color: rgb(0.14, 0.13, 0.12) });
    p1.drawText('Bank Account No:    00491820045199', { x: 62, y: 382, size: 11, font: mono, color: rgb(0.14, 0.13, 0.12) });
    p1.drawText('Internal API Token: sk_live_98a7f22e110c4b8e99d1', { x: 62, y: 358, size: 11, font: mono, color: rgb(0.14, 0.13, 0.12) });
    p1.drawText('Routing Swift Code: HDFCINBBBLR', { x: 62, y: 334, size: 11, font: mono, color: rgb(0.14, 0.13, 0.12) });

    p1.drawText('Approval Stamp Area:', { x: 48, y: 268, size: 10.5, font: bold, color: rgb(0.35, 0.33, 0.3) });

    const p2 = doc.addPage([595.28, 841.89]);
    p2.drawText('PAGE 2 — VECTOR RETENTION VERIFICATION', {
        x: 48, y: 780, size: 14, font: bold, color: rgb(0.14, 0.13, 0.12),
    });
    p2.drawText('When Page 1 contains a Confidential Redaction with Burn-In enabled, Page 1 is rasterized', {
        x: 48, y: 745, size: 11, font: sans, color: rgb(0.2, 0.19, 0.17),
    });
    p2.drawText('at 200 DPI so redacted secrets cannot be copied, while Page 2 stays 100% crisp vector text.', {
        x: 48, y: 726, size: 11, font: sans, color: rgb(0.2, 0.19, 0.17),
    });

    return {
        name: 'confidential_audit_invoice.pdf',
        bytes: new Uint8Array(await doc.save()),
    };
}
