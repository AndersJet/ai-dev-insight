import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createMemberTemplate, parseMemberFile } from '../src/member-file.js';
test('real workbook template round-trips member fields and blank updates remain absent', async () => {
  const template = await createMemberTemplate('00000000-0000-4000-8000-000000000001', '模板部门');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Uint8Array.from(template).buffer);
  const sheet = workbook.getWorksheet('成员'); assert.ok(sheet);
  sheet.addRow([' PERSON@EXAMPLE.INVALID ', '合成员工']);
  sheet.addRow(['existing@example.invalid', '']);
  const parsed = await parseMemberFile(Buffer.from(await workbook.xlsx.writeBuffer()), 'members.xlsx');
  assert.equal(parsed.departmentId, '00000000-0000-4000-8000-000000000001');
  assert.equal(parsed.rows[0]?.email, 'person@example.invalid'); assert.equal(parsed.rows[0]?.eligible, undefined);
  assert.equal(parsed.rows[0]?.eligibility_from, undefined);
  assert.equal(parsed.rows[0]?.eligibility_to, undefined);
  assert.equal(parsed.rows[1]?.display_name, undefined); assert.equal(parsed.rows[1]?.eligible, undefined);
});
test('retired eligibility, formulas, unsupported columns and oversized uploads are rejected', async () => {
  await assert.rejects(parseMemberFile(Buffer.from('工作邮箱,姓名,Trae资格\na@example.invalid,成员,有效\n'), 'retired.csv'),{code:'unsupported_columns'});
  await assert.rejects(parseMemberFile(Buffer.alloc(5 * 1024 * 1024 + 1), 'large.csv'), { code: 'file_too_large' });
  await assert.rejects(parseMemberFile(Buffer.from('工作邮箱,姓名,角色\na@example.invalid,成员,super'), 'roles.csv'), { code: 'unsupported_columns' });
  await assert.rejects(parseMemberFile(Buffer.from('工作邮箱,__proto__\na@example.invalid,成员'), 'prototype.csv'), { code: 'unsupported_columns' });
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('成员'); sheet.addRow(['工作邮箱', '姓名']); sheet.addRow(['a@example.invalid', { formula: '1+1', result: 2 }]);
  const formulas = await parseMemberFile(Buffer.from(await book.xlsx.writeBuffer()), 'formula.xlsx'); assert.ok(formulas.rows[0]?.errors.includes('formula_not_allowed'));
});

test('small compressed workbooks cannot expand past the import budget and row limits are enforced', async () => {
  const { zipSync } = await import('fflate');
  const oversized = zipSync({
    'xl/workbook.xml': Buffer.from('<workbook/>'),
    'xl/sharedStrings.xml': Buffer.from('<sst>' + 'x'.repeat(20 * 1024 * 1024) + '</sst>'),
  });
  assert.ok(oversized.length < 5 * 1024 * 1024, 'compressed bytes are below the upload limit');
  await assert.rejects(parseMemberFile(Buffer.from(oversized), 'expanded.xlsx'), { code: 'invalid_or_oversized_workbook' });
  const rows = Array.from({ length: 2000 }, (_, index) => [`row-${index}@example.invalid`, `成员${index}`]);
  const csv = '工作邮箱,姓名\n' + rows.map(row => row.join(',')).join('\n');
  assert.equal((await parseMemberFile(Buffer.from(csv), 'allowed.csv')).rows.length, 2000);
  await assert.rejects(parseMemberFile(Buffer.from(csv + '\nextra@example.invalid,超量'), 'extra.csv'), { code: 'too_many_rows' });
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('成员');
  sheet.addRow(['工作邮箱', '姓名']); sheet.addRows(rows); sheet.addRow(['extra@example.invalid', '超量']);
  await assert.rejects(parseMemberFile(Buffer.from(await book.xlsx.writeBuffer()), 'extra.xlsx'), { code: 'invalid_or_oversized_workbook' });
});

test('a formula-like department name remains template text and the template contains no password column', async () => {
  const { unzipSync } = await import('fflate');
  const template = await createMemberTemplate('00000000-0000-4000-8000-000000000001', '=HYPERLINK("https://example.invalid","部门")');
  for (const [name, data] of Object.entries(unzipSync(template))) {
    if (name.endsWith('.xml')) assert.doesNotMatch(Buffer.from(data).toString('utf8'), /<(?:\w+:)?f(?:\s|>)/, name);
  }
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Uint8Array.from(template).buffer);
  const sheet = book.getWorksheet('成员')!; assert.equal(sheet.columnCount, 2);
  assert.deepEqual(Array.from({ length: 2 }, (_, index) => sheet.getRow(1).getCell(index + 1).text), ['工作邮箱', '姓名']);
  assert.equal((await parseMemberFile(template, 'template.xlsx')).rows.length, 0);
});
