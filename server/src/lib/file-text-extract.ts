/**
 * Best-effort text extraction from uploaded project files (PDF, DOCX).
 * Other types return empty string (caller may still mark ingested to avoid loops).
 */
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

const MAX_CHARS = 120_000;

function extOf(name: string): string {
  const n = String(name || "").toLowerCase();
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i + 1) : "";
}

export async function extractTextFromFileBuffer(
  buffer: Buffer,
  opts: { filename: string; mimeType: string }
): Promise<string> {
  const ext = extOf(opts.filename);
  const mime = (opts.mimeType || "").toLowerCase();

  try {
    if (ext === "pdf" || mime === "application/pdf" || mime === "application/x-pdf") {
      const data = await pdfParse(buffer);
      const t = (data.text || "").trim();
      return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;
    }
    if (ext === "docx" || mime.includes("wordprocessingml") || mime.includes("msword")) {
      const { value } = await mammoth.extractRawText({ buffer });
      const t = (value || "").trim();
      return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;
    }
  } catch (e) {
    console.error("[file-text-extract]", opts.filename, e);
  }
  return "";
}
