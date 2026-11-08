/**
 * Reading an uploaded Excel file into plain rows. No checking of values
 * here (that is validate.ts); only finding the sheet and the columns, and
 * turning Excel cell types into text, numbers and YYYY-MM-DD dates, so the
 * rows can be stored as JSON until the import is confirmed.
 */
import ExcelJS from 'exceljs';
import { simplify, text } from '../intake/normalize.js';
import { COLUMNS, DATA_SHEET, MAX_IMPORT_ROWS } from './columns.js';
import { colLetter } from './template.js';

export type CellValue = string | number | null;

export interface RawRow {
  /** The row number in Excel, for the check report. */
  row: number;
  cells: Record<string, CellValue>;
}

export interface ParsedSheet {
  /** Column key -> Excel column letter, e.g. { amount: 'N' }. */
  columns: Record<string, string>;
  rows: RawRow[];
}

export type ParseResult =
  | { ok: true; sheet: ParsedSheet; warnings: string[] }
  | { ok: false; unreadable: boolean; errors: string[] };

const pad = (n: number) => String(n).padStart(2, '0');

/** Excel cell value to text, number or date text. */
export function cellValue(v: ExcelJS.CellValue): CellValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    // exceljs gives the date at midnight UTC.
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
    if ('formula' in v || 'sharedFormula' in v) return cellValue((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ('hyperlink' in v && 'text' in v) return cellValue((v as { text: ExcelJS.CellValue }).text);
    if ('error' in v) return String((v as { error: string }).error);
  }
  return null;
}

/** Find which column holds which field, from the header row. */
function mapHeader(ws: ExcelJS.Worksheet): { columns: Record<string, string>; errors: string[]; warnings: string[] } {
  const byName = new Map<string, string>();
  for (const c of COLUMNS) {
    for (const name of [c.key, c.en, c.ar]) byName.set(simplify(name), c.key);
  }
  const columns: Record<string, string> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const header = ws.getRow(1);
  for (let i = 1; i <= Math.max(header.cellCount, ws.columnCount); i++) {
    const value = cellValue(header.getCell(i).value);
    // Keep the line break between the English and the Arabic name (text() would join them).
    const raw = value === null ? '' : String(value).replace(/\*/g, '').trim();
    if (!text(raw)) continue;
    let key: string | undefined;
    for (const part of raw.split(/\r?\n|\s+\/\s+/)) {
      key = byName.get(simplify(part));
      if (key) break;
    }
    if (!key) key = byName.get(simplify(raw));
    const letter = colLetter(i);
    if (!key) {
      warnings.push(`Column ${letter} ("${raw.split(/\n/)[0]}") is not a template column and was ignored`);
    } else if (columns[key]) {
      errors.push(`Column "${COLUMNS.find((c) => c.key === key)!.en}" appears twice (${columns[key]} and ${letter})`);
    } else {
      columns[key] = letter;
    }
  }
  const missing = COLUMNS.filter((c) => c.required && !columns[c.key]).map((c) => `"${c.en}"`);
  if (missing.length) errors.push(`Required columns are missing: ${missing.join(', ')}. Please use the template.`);
  return { columns, errors, warnings };
}

export async function parseWorkbook(bytes: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    return { ok: false, unreadable: true, errors: ['This file could not be read as an Excel workbook (.xlsx)'] };
  }

  const sheets = wb.worksheets.filter((s) => s.state === 'visible');
  const ws =
    sheets.find((s) => s.name.trim().toLowerCase() === DATA_SHEET.toLowerCase() || s.name.trim() === 'الديون') ??
    sheets.find((s) => !['instructions', 'lists'].includes(s.name.trim().toLowerCase()));
  if (!ws) return { ok: false, unreadable: false, errors: [`The workbook has no "${DATA_SHEET}" sheet`] };

  const head = mapHeader(ws);
  if (head.errors.length) return { ok: false, unreadable: false, errors: head.errors };

  const letterToKey = Object.fromEntries(Object.entries(head.columns).map(([k, l]) => [l, k]));
  const rows: RawRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: Record<string, CellValue> = {};
    let empty = true;
    for (const [letter, key] of Object.entries(letterToKey)) {
      const v = cellValue(row.getCell(letter).value);
      const blank = v === null || (typeof v === 'string' && v.trim() === '');
      cells[key] = blank ? null : v;
      if (!blank) empty = false;
    }
    if (empty) continue;
    rows.push({ row: r, cells });
    if (rows.length > MAX_IMPORT_ROWS) {
      return {
        ok: false,
        unreadable: false,
        errors: [`The sheet has more than ${MAX_IMPORT_ROWS} rows. Split it into several files.`],
      };
    }
  }
  if (!rows.length) return { ok: false, unreadable: false, errors: ['The sheet has no rows to import'] };
  return { ok: true, sheet: { columns: head.columns, rows }, warnings: head.warnings };
}
