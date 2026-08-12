/**
 * CustomerImportService — parse Excel/CSV → preview → confirm-import.
 *
 * Pipeline:
 *   1. parseSheet(filePath) → { headers, rows }
 *   2. previewMapping(rows, mapping) → { newCount, updateCount, errors[] }
 *   3. confirmImport(rows, mapping, options) → CustomerImportBatch
 *
 * Imports never auto-trigger sends. The batch is just a record of who came in.
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parse as csvParse } from 'csv-parse/sync';
import { prisma } from '../lib/prisma.js';
import { normalizePhone, phoneToJid } from './phone.js';

export type ImportMapping = {
  phone?: string;
  name?: string;
  city?: string;
  address?: string;
  status?: string;
  tags?: string;
  notes?: string;
  source?: string;
  campaign?: string;
  whatsapp_account?: string;
};

const FIELD_KEYS = ['phone', 'name', 'city', 'address', 'status', 'tags', 'notes', 'source', 'campaign', 'whatsapp_account'] as const;

/** Heuristic: column header → field key. Recognizes Arabic, English, French, snake/camel. */
const HEADER_HINTS: Record<keyof ImportMapping, RegExp[]> = {
  phone: [/phone/i, /tel/i, /mobile/i, /^هاتف$/, /رقم/i, /jid/i, /whatsapp$/i],
  name: [/^name$/i, /full[_-]?name/i, /^nom$/i, /^الاسم$/, /اسم/i],
  city: [/city/i, /ville/i, /مدين/i],
  address: [/address/i, /adresse/i, /عنوان/i],
  status: [/status/i, /statut/i, /حال/i],
  tags: [/tags?/i, /وسوم/i, /étiquette/i],
  notes: [/notes?/i, /ملاحظ/i],
  source: [/source/i, /مصدر/i],
  campaign: [/campaign/i, /campagne/i, /حملة/i],
  whatsapp_account: [/account|whatsapp[_-]?account|wa[_-]?account/i, /حساب/i],
};

const tryAutoMap = (headers: string[]): ImportMapping => {
  const m: ImportMapping = {};
  for (const key of FIELD_KEYS) {
    const hints = HEADER_HINTS[key];
    const found = headers.find((h) => hints.some((rx) => rx.test(h)));
    if (found) (m as any)[key] = found;
  }
  return m;
};

interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];   // each row keyed by header
}

async function parseExcel(filePath: string): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col - 1] = String(cell.value ?? '').trim();
  });

  const rows: Record<string, string>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const r: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = row.getCell(i + 1).value;
      // Excel can produce { result, formula } / { text } / { hyperlink, text }
      if (v == null) { r[h] = ''; return; }
      if (typeof v === 'object') {
        if ('text' in v) r[h] = String((v as any).text ?? '');
        else if ('result' in v) r[h] = String((v as any).result ?? '');
        else r[h] = String(v);
      } else {
        r[h] = String(v);
      }
    });
    rows.push(r);
  });
  return { headers, rows };
}

async function parseCsv(filePath: string): Promise<ParsedSheet> {
  let buf = fs.readFileSync(filePath, 'utf8');
  if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);  // strip BOM
  const records = csvParse(buf, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}

export const CustomerImportService = {
  async parseFile(filePath: string, originalName: string): Promise<ParsedSheet> {
    const ext = path.extname(originalName).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') return parseExcel(filePath);
    if (ext === '.csv' || ext === '.tsv') return parseCsv(filePath);
    throw Object.assign(new Error('unsupported_file_extension'), { status: 400 });
  },

  autoMap(headers: string[]): ImportMapping {
    return tryAutoMap(headers);
  },

  /**
   * Validate rows + simulate import. Doesn't write to DB.
   * Returns counts + per-row errors (max 100 errors to keep payload small).
   */
  async preview(parsed: ParsedSheet, mapping: ImportMapping, defaultAccountId: string | null): Promise<{
    valid: number;
    newCount: number;
    updateCount: number;
    errors: { row: number; reason: string }[];
  }> {
    if (!mapping.phone) {
      return { valid: 0, newCount: 0, updateCount: 0, errors: [{ row: 0, reason: 'phone_column_required' }] };
    }
    const errors: { row: number; reason: string }[] = [];
    const phones: string[] = [];
    parsed.rows.forEach((row, idx) => {
      const raw = row[mapping.phone!];
      const norm = normalizePhone(raw);
      if (!norm) {
        if (errors.length < 100) errors.push({ row: idx + 2, reason: 'invalid_or_empty_phone' });
        return;
      }
      phones.push(norm);
    });

    if (!phones.length) {
      return { valid: 0, newCount: 0, updateCount: 0, errors };
    }

    const accountId = mapping.whatsapp_account
      ? null  // mapping per row — handled at confirm time
      : defaultAccountId;

    if (accountId) {
      // Look up existing contacts on this account
      const jids = phones.map(phoneToJid);
      const existing = await prisma.contact.findMany({
        where: { accountId, jid: { in: jids } },
        select: { jid: true },
      });
      const existingSet = new Set(existing.map((e) => e.jid));
      let updateCount = 0, newCount = 0;
      for (const p of phones) {
        if (existingSet.has(phoneToJid(p))) updateCount++;
        else newCount++;
      }
      return { valid: phones.length, newCount, updateCount, errors };
    }
    // No default account — caller must provide one or per-row mapping
    return { valid: phones.length, newCount: phones.length, updateCount: 0, errors };
  },

  /**
   * Commit the import. Behaviour: 'skip_existing' | 'update_existing' | 'merge_tags'.
   * Returns the created CustomerImportBatch row.
   */
  async commit(opts: {
    parsed: ParsedSheet;
    mapping: ImportMapping;
    fileName: string;
    source: 'excel' | 'csv' | 'google_sheets';
    accountId: string;     // required — required at row level only if mapping says so; else this is the default
    behavior: 'skip_existing' | 'update_existing' | 'merge_tags';
    importTag?: string;    // applied to every imported contact
  }) {
    if (!opts.mapping.phone) throw Object.assign(new Error('phone_column_required'), { status: 400 });

    const batch = await prisma.customerImportBatch.create({
      data: {
        fileName: opts.fileName,
        source: opts.source,
        totalRows: opts.parsed.rows.length,
        mapping: JSON.stringify(opts.mapping),
      },
    });

    let imported = 0, updated = 0, skipped = 0, failed = 0;
    const errors: { row: number; reason: string }[] = [];

    for (let i = 0; i < opts.parsed.rows.length; i++) {
      const row = opts.parsed.rows[i];
      const phone = normalizePhone(row[opts.mapping.phone!]);
      if (!phone) { failed++; if (errors.length < 100) errors.push({ row: i + 2, reason: 'invalid_phone' }); continue; }
      const jid = phoneToJid(phone);

      const existing = await prisma.contact.findUnique({
        where: { accountId_jid: { accountId: opts.accountId, jid } },
      });

      const tagsArr: string[] = [];
      if (opts.importTag) tagsArr.push(opts.importTag);
      if (opts.mapping.tags) {
        const raw = row[opts.mapping.tags];
        if (raw) raw.split(/[,;]+/).map((x) => x.trim()).filter(Boolean).forEach((t) => tagsArr.push(t));
      }

      const data: any = {
        accountId: opts.accountId,
        jid,
        name: opts.mapping.name ? row[opts.mapping.name]?.trim() || null : null,
        city: opts.mapping.city ? row[opts.mapping.city]?.trim() || null : null,
        address: opts.mapping.address ? row[opts.mapping.address]?.trim() || null : null,
        status: opts.mapping.status ? row[opts.mapping.status]?.trim() || 'new' : 'new',
        notes: opts.mapping.notes ? row[opts.mapping.notes]?.trim() || null : null,
        source: opts.mapping.source ? row[opts.mapping.source]?.trim() || 'import' : 'import',
        campaignName: opts.mapping.campaign ? row[opts.mapping.campaign]?.trim() || null : null,
        importBatchId: batch.id,
      };

      try {
        if (existing) {
          if (opts.behavior === 'skip_existing') { skipped++; continue; }
          let mergedTags = tagsArr;
          if (opts.behavior === 'merge_tags' && existing.tags) {
            try {
              const old = JSON.parse(existing.tags) as string[];
              mergedTags = Array.from(new Set([...old, ...tagsArr]));
            } catch {}
          }
          await prisma.contact.update({
            where: { id: existing.id },
            data: {
              ...data,
              tags: mergedTags.length ? JSON.stringify(mergedTags) : existing.tags,
            },
          });
          updated++;
        } else {
          await prisma.contact.create({
            data: {
              ...data,
              tags: tagsArr.length ? JSON.stringify(tagsArr) : null,
            },
          });
          imported++;
        }
      } catch (e) {
        failed++;
        if (errors.length < 100) errors.push({ row: i + 2, reason: (e as Error).message.slice(0, 100) });
      }
    }

    const result = await prisma.customerImportBatch.update({
      where: { id: batch.id },
      data: {
        importedRows: imported,
        updatedRows: updated,
        skippedRows: skipped,
        failedRows: failed,
        errors: errors.length ? JSON.stringify(errors) : null,
      },
    });
    return result;
  },

  async listBatches() {
    return prisma.customerImportBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  },
};
