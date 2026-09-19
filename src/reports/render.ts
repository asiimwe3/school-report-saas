/** Renderers for ReportCardData: printable HTML (PDF via browser print) + DOCX. */
import type { ReportCardData } from "../services/reports";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const fmt = (n: number | null | undefined, d = 0) =>
  n === null || n === undefined ? "—" : Number(n).toFixed(d).replace(/\.0+$/, "");

const dateFmt = (d?: Date | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";

/** A4 printable HTML — the browser's Print → Save as PDF produces the PDF. */
export function renderPrintHtml(d: ReportCardData): string {
  const rows = d.subjects
    .map(
      (s) => `<tr>
<td>${esc(s.subject)}</td><td class="c">${fmt(s.total, 1)}</td><td class="c">${fmt(s.percentage, 1)}</td>
<td class="c">${esc(s.grade ?? "—")}</td><td class="c">${s.points ?? "—"}</td><td>${esc(s.remark ?? "")}</td></tr>`
    )
    .join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Report Card — ${esc(d.student.name)}</title>
<style>
 @page { size: A4; margin: 14mm 12mm; }
 body { font-family: "Segoe UI", Arial, sans-serif; color: #12233f; margin: 0; }
 .sheet { max-width: 186mm; margin: 0 auto; }
 header { text-align: center; border-bottom: 3px solid #12233f; padding-bottom: 8px; margin-bottom: 12px; }
 h1 { margin: 0; font-size: 20px; letter-spacing: .04em; }
 .motto { font-size: 11px; color: #55677f; font-style: italic; margin-top: 2px; }
 .doc-title { text-align:center; font-size: 13px; font-weight: 700; margin: 10px 0 8px; }
 table { width: 100%; border-collapse: collapse; font-size: 12px; }
 th, td { border: 1px solid #9db0c8; padding: 4px 8px; text-align: left; }
 th { background: #12233f; color: #fff; font-weight: 600; }
 .c { text-align: center; }
 .meta td { border: none; padding: 2px 6px 2px 0; font-size: 12px; }
 .meta b { font-weight: 700; }
 .summary td { padding: 6px 8px; }
 .comment { margin-top: 12px; font-size: 12px; }
 .comment b { display: inline-block; min-width: 130px; }
 .sig { margin-top: 34px; display: flex; justify-content: space-between; font-size: 11px; }
 .sig div { border-top: 1px solid #12233f; padding-top: 3px; width: 42%; text-align: center; }
 .footer { margin-top: 10px; font-size: 10px; color: #6b7c92; text-align: center; }
 @media print { .noprint { display: none; } }
 .noprint { text-align: center; margin: 10px; }
 .noprint button { background:#12233f; color:#fff; border:none; padding:8px 18px; border-radius:6px; cursor:pointer; }
</style></head>
<body><div class="sheet">
<header>
<h1>${esc(d.schoolName)}</h1>
${d.schoolMotto ? `<div class="motto">${esc(d.schoolMotto)}</div>` : ""}
</header>
<div class="doc-title">TERMINAL REPORT CARD — ${esc(d.term.name)} (${esc(d.term.year)})</div>
<table class="meta"><tbody>
<tr><td><b>Name:</b> ${esc(d.student.name)}</td><td><b>Adm. No:</b> ${esc(d.student.admissionNo)}</td><td><b>Sex:</b> ${esc(d.student.sex)}</td></tr>
<tr><td><b>Class:</b> ${esc(d.student.className)}${d.student.stream ? " / " + esc(d.student.stream) : ""}</td>
<td><b>Roll No:</b> ${d.student.rollNo ?? "—"}</td>
<td><b>Term Ends:</b> ${dateFmt(d.term.endDate)}</td></tr>
</tbody></table>
<p></p>
<table>
<thead><tr><th>Subject</th><th class="c">Total</th><th class="c">%</th><th class="c">Grade</th><th class="c">Pts</th><th>Remark</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6" class="c">No results recorded yet.</td></tr>'}
</tbody>
</table>
<p></p>
<table class="summary"><tbody>
<tr><td><b>Summary</b></td><td class="c"><b>${d.summary.division ?? "—"}</b></td>
<td><b>Attendance</b></td><td class="c">${d.attendance ? `${d.attendance.present}/${d.attendance.total} days present (${d.attendance.absent} absent)` : "—"}</td></tr>
</tbody></table>
<div class="comment"><b>Class Teacher:</b> ${esc(d.comments.classTeacher ?? "")}</div>
<div class="comment"><b>Head Teacher:</b> ${esc(d.comments.headTeacher ?? "")}</div>
<div class="sig">
<div>Class Teacher's Signature</div><div>Head Teacher's Signature</div><div>Parent's Signature</div>
</div>
<div class="footer">Next term begins: ${dateFmt(d.term.nextTermBegins) || "To be announced"} · Generated ${d.generatedAt.toISOString().slice(0, 10)} by DeryCode Reports</div>
<div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div>
</div></body></html>`;
}

/** DOCX report card via the `docx` package (server-side, no Word needed). */
export async function renderDocx(d: ReportCardData): Promise<Buffer> {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
    AlignmentType, BorderStyle,
  } = await import("docx");

  const B = { style: BorderStyle.SINGLE, size: 4, color: "9DB0C8" };
  const cell = (text: string, opts: { bold?: boolean; width?: number; center?: boolean } = {}) =>
    new TableCell({
      borders: { top: B, bottom: B, left: B, right: B },
      width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
      children: [new Paragraph({ alignment: opts.center ? AlignmentType.CENTER : undefined,
        children: [new TextRun({ text, bold: opts.bold, size: 22 })] })],
    });

  const header = new TableRow({
    tableHeader: true,
    children: [
      cell("Subject", { bold: true }), cell("Total", { bold: true, center: true }),
      cell("%", { bold: true, center: true }), cell("Grade", { bold: true, center: true }),
      cell("Pts", { bold: true, center: true }), cell("Remark", { bold: true }),
    ],
  });

  const subjectRows = d.subjects.map(
    (s) =>
      new TableRow({
        children: [
          cell(s.subject), cell(fmt(s.total, 1), { center: true }),
          cell(fmt(s.percentage, 1), { center: true }), cell(s.grade ?? "—", { center: true }),
          cell(s.points === null ? "—" : String(s.points), { center: true }), cell(s.remark ?? ""),
        ],
      })
  );

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: d.schoolName, bold: true, size: 34 })] }),
          ...(d.schoolMotto
            ? [new Paragraph({ alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: d.schoolMotto, italics: true, size: 20, color: "55677F" })] })]
            : []),
          new Paragraph({ alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `TERMINAL REPORT CARD — ${d.term.name} (${d.term.year})`, bold: true, size: 24 })] }),
          new Paragraph({ children: [] }),
          ...[
            `Name: ${d.student.name}`,
            `Admission No: ${d.student.admissionNo}    Sex: ${d.student.sex}`,
            `Class: ${d.student.className}${d.student.stream ? " / " + d.student.stream : ""}    Roll No: ${d.student.rollNo ?? "—"}`,
            `Term ends: ${dateFmt(d.term.endDate)}`,
          ].map((t) => new Paragraph({ children: [new TextRun({ text: t, size: 22 })] })),
          new Paragraph({ children: [] }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...subjectRows] }),
          new Paragraph({ children: [] }),
          new Paragraph({ children: [new TextRun({ text: `Summary: ${d.summary.division ?? "—"}`, bold: true, size: 22 })] }),
          new Paragraph({
            children: [new TextRun({
              text: d.attendance
                ? `Attendance: ${d.attendance.present}/${d.attendance.total} days present (${d.attendance.absent} absent)`
                : "Attendance: —",
              size: 22 })],
          }),
          new Paragraph({ children: [new TextRun({ text: `Class Teacher: ${d.comments.classTeacher ?? ""}`, size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: `Head Teacher: ${d.comments.headTeacher ?? ""}`, size: 22 })] }),
          new Paragraph({ children: [] }),
          new Paragraph({
            children: [new TextRun({
              text: `Next term begins: ${dateFmt(d.term.nextTermBegins) || "To be announced"}`,
              size: 20, color: "6B7C92" })],
          }),
          new Paragraph({
            children: [new TextRun({
              text: `Generated ${d.generatedAt.toISOString().slice(0, 10)} by DeryCode Reports`,
              size: 18, color: "6B7C92" })],
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
