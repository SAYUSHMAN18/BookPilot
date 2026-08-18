const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

// Knowledge-base document upload — extracts plain text from whatever an
// admin/provider drags in, so it can be reviewed and saved into the same
// knowledge_documents.content column a hand-typed entry already fills.
// Never persisted as a file (see uploads.js's uploadDocument comment) —
// this runs once, in memory, against the raw upload buffer.
async function extractTextFromDocument(buffer, mimetype) {
  if (mimetype === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text || "";
    } finally {
      await parser.destroy();
    }
  }

  if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  // text/plain — the fileFilter in uploads.js already rejects anything else
  return buffer.toString("utf8");
}

module.exports = { extractTextFromDocument };
