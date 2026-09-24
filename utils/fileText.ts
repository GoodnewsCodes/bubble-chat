import * as mammoth from 'mammoth';

/**
 * Extract plain text from a document buffer for brain ingestion.
 * Supports PDF (pdf-parse v2), DOCX (mammoth), and plain-text formats.
 *
 * @returns the extracted text, or `null` when the type is unsupported (caller
 *          should treat null as a 415, empty string as "no extractable text").
 */
export const extractTextFromFile = async (
    buffer: Buffer,
    mime: string,
    filenameLower: string
): Promise<string | null> => {
    const m = (mime || '').toLowerCase();

    // ── PDF ──────────────────────────────────────────────────────────────────
    if (m === 'application/pdf' || filenameLower.endsWith('.pdf')) {
        // pdf-parse v2 is ESM with no default export — use the PDFParse class.
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
            const result = await parser.getText();
            return (result?.text || '').replace(/\s+\n/g, '\n').trim();
        } finally {
            try { await parser.destroy(); } catch { /* ignore */ }
        }
    }

    // ── DOCX ─────────────────────────────────────────────────────────────────
    if (
        m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        filenameLower.endsWith('.docx')
    ) {
        const { value } = await mammoth.extractRawText({ buffer });
        return (value || '').trim();
    }

    // ── Plain text formats ───────────────────────────────────────────────────
    if (m.startsWith('text/') || /\.(txt|md|markdown|csv|json|log|tsv)$/i.test(filenameLower)) {
        return buffer.toString('utf8').trim();
    }

    return null;
};
