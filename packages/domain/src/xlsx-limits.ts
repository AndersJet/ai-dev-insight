import { inflateRawSync } from 'node:zlib';
import { DomainError } from './errors.js';
const MAX_EXPANDED = 20 * 1024 * 1024;
// Inspect and bound actual inflation before the workbook object graph is allocated.
export function validateXlsxArchive(data: Buffer) {
  try {
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { eocd = i; break; }
    if (eocd < 0 || data.readUInt16LE(eocd + 4) || data.readUInt16LE(eocd + 6)) throw new Error();
    const entries = data.readUInt16LE(eocd + 10); const directory = data.readUInt32LE(eocd + 16); const directorySize = data.readUInt32LE(eocd + 12);
    if (!entries || entries > 300 || directory + directorySize > eocd) throw new Error();
    let cursor = directory; let expanded = 0; const names = new Set<string>();
    for (let i = 0; i < entries; i++) {
      if (cursor + 46 > eocd || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error();
      const flags = data.readUInt16LE(cursor + 8); const method = data.readUInt16LE(cursor + 10);
      const compressedSize = data.readUInt32LE(cursor + 20); const expectedSize = data.readUInt32LE(cursor + 24);
      const nameSize = data.readUInt16LE(cursor + 28); const extraSize = data.readUInt16LE(cursor + 30); const commentSize = data.readUInt16LE(cursor + 32); const local = data.readUInt32LE(cursor + 42);
      const name = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(cursor + 46, cursor + 46 + nameSize));
      if (flags & 1 || ![0, 8].includes(method) || expectedSize > MAX_EXPANDED - expanded || names.has(name) || name.includes('..') || name.includes('\\') || name.startsWith('/') || /vbaProject|externalLinks/i.test(name)) throw new Error();
      names.add(name);
      if (local + 30 > directory || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 8) !== method) throw new Error();
      const localNameSize = data.readUInt16LE(local + 26); const start = local + 30 + localNameSize + data.readUInt16LE(local + 28);
      if (data.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== name || start + compressedSize > directory) throw new Error();
      const compressed = data.subarray(start, start + compressedSize);
      const body = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, MAX_EXPANDED - expanded) });
      if (body.length !== expectedSize) throw new Error(); expanded += body.length;
      if (name.endsWith('.xml')) {
        const xml = new TextDecoder('utf-8', { fatal: true }).decode(body);
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error();
        let rows = 0; let cells = 0; let strings = 0;
        for (const tag of xml.matchAll(/<(?:[\w.-]+:)?(row|c|si)\b([^>]*)>/g)) {
          if (tag[1] === 'row') { if (++rows > 2001) throw new Error(); const row = /\br=["'](\d+)["']/.exec(tag[2] ?? ''); if (row && Number(row[1]) > 2001) throw new Error(); }
          if (tag[1] === 'c' && ++cells > 20000) throw new Error();
          if (tag[1] === 'si' && ++strings > 20000) throw new Error();
        }
      }
      cursor += 46 + nameSize + extraSize + commentSize;
    }
    if (cursor !== directory + directorySize || !names.has('xl/workbook.xml')) throw new Error();
  } catch { throw new DomainError('invalid_or_oversized_workbook', 422); }
}
