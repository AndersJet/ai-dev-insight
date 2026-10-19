import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { DomainError } from './errors.js';
import { validateXlsxArchive } from './xlsx-limits.js';
export interface FileMember { row: number; email: string; display_name?: string; eligible?: boolean | null; eligibility_from?: string; eligibility_to?: string | null; errors: string[] }
export interface ParsedMembers { departmentId: string | null; rows: FileMember[] }
const headers = ['工作邮箱', '姓名'];
const aliases: Record<string, string> = { 工作邮箱: 'email', email: 'email', 姓名: 'display_name', display_name: 'display_name' };
export async function createMemberTemplate(id: string, name: string): Promise<Buffer> {
  const book = new ExcelJS.Workbook(); book.creator = 'AI Dev Insight'; book.subject = `adi-department:${id}`;
  const sheet = book.addWorksheet('成员', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow(headers); sheet.columns.forEach((column, i) => { column.width = [32, 22, 22, 22, 22][i]!; });
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } }; sheet.getRow(1).height = 25;
  sheet.autoFilter = 'A1:B1';
  sheet.getCell('A1').note = `当前部门：${name}。邮箱全局唯一；同一文件重复邮箱或跨部门冲突需修正后整批提交。`;
  sheet.getCell('B1').note = '新增人员必填；更新时空白不覆盖原姓名。';
  return Buffer.from(await book.xlsx.writeBuffer());
}
function text(value: unknown, errors: string[]): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) { errors.push('formula_not_allowed'); return ''; }
    if ('text' in value && typeof value.text === 'string') return value.text.trim(); // Hyperlink target is never followed.
    if (value instanceof Date) { if (!Number.isFinite(value.getTime())) { errors.push('invalid_date'); return ''; } return value.toISOString(); }
    errors.push('invalid_cell'); return '';
  }
  const result = String(value).trim();
  if (/^[=+@]/.test(result)) errors.push('formula_like_value');
  if (result.length > 4096) errors.push('cell_too_long');
  return result.slice(0, 4096);
}
export async function parseMemberFile(data: Buffer, filename: string): Promise<ParsedMembers> {
  if (data.length > 5 * 1024 * 1024) throw new DomainError('file_too_large', 413);
  let values: unknown[][]; let departmentId: string | null = null;
  if (/\.xlsx$/i.test(filename)) {
    validateXlsxArchive(data); const book = new ExcelJS.Workbook(); await book.xlsx.load(Uint8Array.from(data).buffer);
    const sheet = book.getWorksheet('成员'); if (!sheet) throw new DomainError('member_sheet_missing', 422);
    departmentId = /^adi-department:([0-9a-f-]{36})$/.exec(book.subject ?? '')?.[1] ?? null;
    if (sheet.rowCount > 2001 || sheet.columnCount > 10) throw new DomainError('file_too_large', 413);
    values = []; for (let i = 1; i <= sheet.rowCount; i++) { const row = sheet.getRow(i); values.push(Array.from({ length: Math.max(5, sheet.columnCount) }, (_, j) => row.getCell(j + 1).value)); }
  } else if (/\.csv$/i.test(filename)) {
    try { values = parse(new TextDecoder('utf-8', { fatal: true }).decode(data), { bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 8192, to: 2002 }); }
    catch { throw new DomainError('invalid_csv', 422); }
  } else throw new DomainError('unsupported_file', 422);
  if (values.length > 2001) throw new DomainError('too_many_rows', 413);
  const headerErrors: string[] = []; const columns = (values[0] ?? []).map(value => text(value, headerErrors));
  while (columns.at(-1) === '') columns.pop();
  const mapped = columns.map(value => Object.hasOwn(aliases, value) ? aliases[value] : undefined);
  if (headerErrors.length || !mapped.includes('email') || mapped.some(value => !value) || new Set(mapped).size !== mapped.length) throw new DomainError('unsupported_columns', 422);
  const rows: FileMember[] = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i]!; const errors: string[] = []; const fields: Record<string, string> = {};
    raw.forEach((value, index) => { const cell = text(value, errors); if (mapped[index]) fields[mapped[index]!] = cell; else if (cell) errors.push('extra_columns'); });
    if (!Object.values(fields).some(Boolean) && !errors.length) continue;
    const row: FileMember = { row: i + 1, email: (fields.email ?? '').toLowerCase(), errors };
    if (fields.display_name) row.display_name = fields.display_name;
    rows.push(row);
  }
  return { departmentId, rows };
}
