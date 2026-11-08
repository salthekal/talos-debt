/**
 * The Excel template clients download, fill in and upload again.
 * Sheet "Debts": one row per debt, with dropdown lists and cell formats that
 * stop Excel from damaging phone and ID numbers. Sheet "Instructions":
 * short bilingual guide with an example of one debtor with two debts.
 */
import ExcelJS from 'exceljs';
import {
  choiceLabel,
  DEBTOR_KIND_CHOICES,
  EMPLOYMENT_CHOICES,
  ID_TYPE_CHOICES,
  LANGUAGE_CHOICES,
  REASON_CHOICES,
} from '../intake/normalize.js';
import type { InstrumentType } from '../intake/records.js';
import { COLUMNS, DATA_SHEET, MAX_IMPORT_ROWS, type ListName } from './columns.js';

const LAST_ROW = MAX_IMPORT_ROWS + 1;
const NONE_LABEL = 'None / لا يوجد';

function lists(types: readonly InstrumentType[]): Record<ListName, string[]> {
  return {
    id_type: ID_TYPE_CHOICES.map(choiceLabel),
    language: LANGUAGE_CHOICES.map(choiceLabel),
    employment: EMPLOYMENT_CHOICES.map(choiceLabel),
    debtor_kind: DEBTOR_KIND_CHOICES.map(choiceLabel),
    reason: REASON_CHOICES.map(choiceLabel),
    instrument: [NONE_LABEL, ...types.map((t) => choiceLabel({ en: t.name_en, ar: t.name_ar ?? t.name_en }))],
  };
}

const colLetter = (index: number) => {
  let s = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export async function buildTemplate(types: readonly InstrumentType[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Talos';
  wb.created = new Date();
  const values = lists(types);

  // --- Debts (the sheet that is imported) ---
  const ws = wb.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  const header = ws.getRow(1);
  header.height = 34;
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = `${c.en}${c.required ? ' *' : ''}\n${c.ar}`;
    cell.font = { bold: true };
    cell.alignment = { wrapText: true, vertical: 'middle' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FFFFE9A8' : 'FFE8EEF4' } };
    cell.note = c.help;
    const col = ws.getColumn(i + 1);
    // Text format keeps leading zeros (05...) and stops long numbers turning into 2E+09.
    if (c.format === 'text') col.numFmt = '@';
    if (c.format === 'date') col.numFmt = 'dd/mm/yyyy';
    if (c.format === 'amount') col.numFmt = '#,##0.00';
  });

  // --- Lists (hidden source of the dropdowns) ---
  const lw = wb.addWorksheet('Lists', { state: 'hidden' });
  const listNames = Object.keys(values) as ListName[];
  listNames.forEach((name, i) => {
    lw.getCell(1, i + 1).value = name;
    values[name].forEach((v, j) => (lw.getCell(j + 2, i + 1).value = v));
  });

  const validations = (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } })
    .dataValidations;
  COLUMNS.forEach((c, i) => {
    const letter = colLetter(i + 1);
    const range = `${letter}2:${letter}${LAST_ROW}`;
    if (c.list) {
      const li = listNames.indexOf(c.list) + 1;
      const src = `Lists!$${colLetter(li)}$2:$${colLetter(li)}$${values[c.list].length + 1}`;
      validations.add(range, {
        type: 'list',
        allowBlank: true,
        formulae: [src],
        showErrorMessage: true,
        errorStyle: 'warning',
        errorTitle: 'Not in the list',
        error: 'Please choose a value from the list. / الرجاء الاختيار من القائمة',
      });
    }
    if (c.format === 'amount') {
      validations.add(range, {
        type: 'decimal',
        operator: 'greaterThan',
        allowBlank: true,
        formulae: [0],
        showErrorMessage: true,
        errorStyle: 'stop',
        errorTitle: 'Amount',
        error: 'Enter an amount more than 0. / أدخل مبلغا أكبر من صفر',
      });
    }
  });

  // --- Instructions ---
  const iw = wb.addWorksheet('Instructions');
  iw.getColumn(1).width = 110;
  const lines: [string, boolean?][] = [
    ['How to fill in this sheet / طريقة تعبئة الملف', true],
    ['1. Use the "Debts" sheet. One row per debt. / استخدم ورقة Debts، صف لكل دين.'],
    ['2. A debtor with several debts: repeat the same ID number on each row. / المدين الذي عليه أكثر من دين: كرر رقم الهوية في كل صف.'],
    ['3. Each debt can have its own instrument (Nafith promissory note, paper note, cheque, or none). / لكل دين سنده الخاص.'],
    ['4. If one promissory note covers several debts, give the same instrument and the same number on those rows. / إذا كان سند واحد يغطي أكثر من دين، اكتب نفس نوع السند ورقمه.'],
    ['5. Columns marked * are required. Point at a header to see a short help note. / الأعمدة المعلمة بـ * إلزامية.'],
    ['6. Saudi phone numbers as 05XXXXXXXX; others with the country code, for example +923001234567.'],
    ['7. Dates: Gregorian, day/month/year. Hijri dates are not accepted. / التواريخ بالميلادي فقط.'],
    ['8. Debtors already in the system keep their details; their new debts and phone numbers are added.'],
    ['9. After uploading you get a check report. Nothing is saved until you confirm, and then all rows are saved together.'],
    [''],
    ['Example: one courier with two debts on one Nafith note, and one with a cheque / مثال', true],
  ];
  lines.forEach(([t, bold], i) => {
    const cell = iw.getCell(i + 1, 1);
    cell.value = t;
    if (bold) cell.font = { bold: true };
    cell.alignment = { wrapText: true };
  });
  const ex = iw.getRow(lines.length + 2);
  const exampleCols = ['id_number', 'full_name', 'phone_1', 'amount', 'reason', 'instrument_type', 'instrument_reference'];
  exampleCols.forEach((k, i) => {
    const c = COLUMNS.find((x) => x.key === k)!;
    ex.getCell(i + 1).value = c.en;
    ex.getCell(i + 1).font = { bold: true };
    if (i > 0) iw.getColumn(i + 1).width = 22;
  });
  const nafith = types.find((t) => t.code === 'nafith_promissory_note');
  const cheque = types.find((t) => t.code === 'cheque');
  const examples = [
    ['2123456789', 'Example Courier', '0501234567', 1500, 'Motorcycle rent, August 2026', nafith ? choiceLabel({ en: nafith.name_en, ar: nafith.name_ar ?? '' }) : '', 'NF-1234567'],
    ['2123456789', 'Example Courier', '0501234567', 640.5, 'Cash collected on 12/09/2026 not handed over', nafith ? choiceLabel({ en: nafith.name_en, ar: nafith.name_ar ?? '' }) : '', 'NF-1234567'],
    ['2987654321', 'Second Example', '+923001234567', 2000, 'Salary advance, July 2026', cheque ? choiceLabel({ en: cheque.name_en, ar: cheque.name_ar ?? '' }) : '', '000123'],
  ];
  examples.forEach((r, j) => r.forEach((v, i) => (iw.getRow(lines.length + 3 + j).getCell(i + 1).value = v)));

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export { colLetter };
