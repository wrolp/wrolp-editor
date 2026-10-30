import { marked } from "marked";
import {
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { dirOf, resolveLocalAsset } from "./markdownAsset";
import { api } from "./tauri";

/** Formats Word can place in a document. Anything else is named in the warning instead. */
const WORD_IMAGE = /\.(?:png|jpe?g|gif)$/i;

/** Width a picture is scaled down to, in CSS pixels at 96 dpi (roughly an A4 text column). */
const CONTENT_WIDTH = 600;

/** Nine points, in the half-points `docx` counts text sizes in. */
const CODE_SIZE = 18;

/** One inline piece of a paragraph, before it becomes a `docx` run. */
type Inline = TextRun | ImageRun;

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

/** A `.docx` file plus the local pictures that could not be placed in it. */
export interface DocxResult {
  blob: Blob;
  /** Absolute paths of pictures left out, so the caller can say how many. */
  missing: string[];
}

/** Base64 for a byte array, in chunks so a few megabytes do not blow the argument limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * A picture as an `ImageRun`, scaled to the text column.
 *
 * The dimensions have to be asked of the browser: Word sizes a picture from the run, not from
 * the file, and a document that guesses produces images that run off the page.
 */
async function imageRun(href: string | undefined, base: string, missing: string[]): Promise<ImageRun | null> {
  const abs = resolveLocalAsset(href ?? null, base);
  if (!abs) return null;
  if (!WORD_IMAGE.test(abs)) {
    // Word understands png/jpeg/gif. An svg or a webp is named rather than dropped silently.
    missing.push(abs);
    return null;
  }
  try {
    await api.allowAssetDir(dirOf(abs));
    const data64 = await api.readExportAsset(abs);
    const binary = atob(data64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([data]));
    const scale = bitmap.width > CONTENT_WIDTH ? CONTENT_WIDTH / bitmap.width : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    bitmap.close?.();
    const kind = abs.toLowerCase().endsWith(".gif") ? "gif" : abs.toLowerCase().match(/\.jpe?g$/) ? "jpg" : "png";
    return new ImageRun({ data, transformation: { width, height }, type: kind });
  } catch {
    missing.push(abs);
    return null;
  }
}

/**
 * The runs one inline token list becomes. Styles accumulate down the tree, so a bold word
 * inside a link keeps both, and a code span inside emphasis keeps its monospace face.
 */
async function inlineRuns(
  tokens: any[] | undefined,
  style: RunStyle,
  base: string,
  missing: string[]
): Promise<Inline[]> {
  const out: Inline[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
      case "escape": {
        // A text token can carry its own inline children (a link label, for instance).
        if (token.tokens?.length) {
          out.push(...(await inlineRuns(token.tokens, style, base, missing)));
        } else if (token.text) {
          out.push(
            new TextRun({
              text: token.text,
              bold: style.bold,
              italics: style.italics,
              strike: style.strike,
              font: style.code ? "Consolas" : undefined,
              color: style.link ? "0B57D0" : undefined,
            })
          );
        }
        break;
      }
      case "strong":
        out.push(...(await inlineRuns(token.tokens, { ...style, bold: true }, base, missing)));
        break;
      case "em":
        out.push(...(await inlineRuns(token.tokens, { ...style, italics: true }, base, missing)));
        break;
      case "del":
        out.push(...(await inlineRuns(token.tokens, { ...style, strike: true }, base, missing)));
        break;
      case "codespan":
        out.push(
          new TextRun({
            text: token.text,
            font: "Consolas",
            size: CODE_SIZE,
            bold: style.bold,
            italics: style.italics,
          })
        );
        break;
      case "link":
        out.push(...(await inlineRuns(token.tokens, { ...style, link: token.href }, base, missing)));
        break;
      case "image": {
        const image = await imageRun(token.href, base, missing);
        if (image) out.push(image);
        break;
      }
      case "br":
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      default:
        if (token.text) {
          out.push(
            new TextRun({
              text: token.text,
              bold: style.bold,
              italics: style.italics,
              strike: style.strike,
              font: style.code ? "Consolas" : undefined,
            })
          );
        }
    }
  }
  return out;
}

/** A heading depth as the `docx` heading level. */
function headingLevel(depth: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  return (
    {
      1: HeadingLevel.HEADING_1,
      2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3,
      4: HeadingLevel.HEADING_4,
      5: HeadingLevel.HEADING_5,
      6: HeadingLevel.HEADING_6,
    } as const
  )[Math.min(6, Math.max(1, depth)) as 1 | 2 | 3 | 4 | 5 | 6];
}

/** One block of the document, as the `docx` element it becomes. */
async function blockOf(
  token: any,
  base: string,
  missing: string[]
): Promise<(Paragraph | Table)[]> {
  switch (token.type) {
    case "heading": {
      const runs = await inlineRuns(token.tokens, {}, base, missing);
      return [
        new Paragraph({
          heading: headingLevel(token.depth),
          spacing: { before: 240, after: 120 },
          children: runs,
        }),
      ];
    }
    case "paragraph": {
      const runs = await inlineRuns(token.tokens, {}, base, missing);
      return runs.length > 0 ? [new Paragraph({ spacing: { after: 120 }, children: runs })] : [];
    }
    case "code": {
      // A paragraph per line, so Word keeps the block together and can break a long one.
      return token.text
        .replace(/\n+$/, "")
        .split("\n")
        .map((line: string) =>
          new Paragraph({
            spacing: { after: 0 },
            shading: { type: "clear", color: "auto", fill: "F5F5F5" },
            children: [
              new TextRun({ text: line || " ", font: "Consolas", size: CODE_SIZE }),
            ],
          })
        );
    }
    case "blockquote": {
      // Flattened rather than wrapped: Word has no quote block, and an indented paragraph
      // would nest one paragraph inside another.
      const inner = await Promise.all(
        (token.tokens ?? []).map((child: any) => blockOf(child, base, missing))
      );
      return inner.flat();
    }
    case "list": {
      const out: Paragraph[] = [];
      let index = 1;
      for (const item of token.items ?? []) {
        const runs = await inlineRuns(item.tokens, {}, base, missing);
        out.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 360, hanging: 240 },
            children: [
              new TextRun({ text: token.ordered ? `${index}. ` : "• " }),
              ...runs,
            ],
          })
        );
        index += 1;
      }
      return out;
    }
    case "table": {
      const header: any[] = token.header ?? [];
      const rows: any[][] = token.rows ?? [];
      // Cells need their runs, which are async; build them before the table is made.
      const builtHeader: TableCell[] = [];
      for (const head of header) {
        builtHeader.push(
          new TableCell({
            shading: { type: "clear", color: "auto", fill: "F0F0F0" },
            children: [
              new Paragraph({
                children: await inlineRuns(head.tokens, { bold: true }, base, missing),
              }),
            ],
          })
        );
      }
      const builtRows: TableRow[] = [];
      for (const row of rows) {
        const cells: TableCell[] = [];
        for (const data of row) {
          cells.push(
            new TableCell({
              children: [new Paragraph({ children: await inlineRuns(data.tokens, {}, base, missing) })],
            })
          );
        }
        builtRows.push(new TableRow({ children: cells }));
      }
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: builtHeader }), ...builtRows],
        }),
      ];
    }
    case "hr":
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC" } },
          children: [],
        }),
      ];
    case "space":
      return [];
    default:
      return [];
  }
}

/**
 * Render markdown into a `.docx`.
 *
 * The tokens come from `marked` rather than from the preview's HTML: a document's structure
 * is what Word needs, and reading it back out of sanitised markup loses the distinction
 * between a heading and a bold paragraph. Pictures are inlined for the same reason the PDF
 * path inlines them — a file path means nothing inside a Word document.
 */
export async function renderDocx(markdown: string, docPath: string): Promise<DocxResult> {
  const tokens = marked.lexer(markdown, { gfm: true, breaks: true });
  const base = dirOf(docPath);
  const missing: string[] = [];
  const children: (Paragraph | Table)[] = [];
  for (const token of tokens) {
    children.push(...(await blockOf(token, base, missing)));
  }
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: children.length > 0 ? children : [new Paragraph({ children: [] })],
      },
    ],
  });
  const blob = await Packer.toBlob(doc);
  return { blob, missing };
}

/** Write a rendered document to disk, as base64 over the invoke wire. */
export async function saveDocx(blob: Blob, path: string): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await api.writeExport(path, toBase64(bytes));
}
