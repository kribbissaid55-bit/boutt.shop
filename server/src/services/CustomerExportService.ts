/**
 * CustomerExportService — clean, predictable Excel/CSV export of contacts.
 *
 * Excel formatting rules (per spec):
 *   - Header row bold + frozen
 *   - Auto-filter on header
 *   - Auto-size columns
 *   - Phone column forced to text (numFmt='@')
 *   - Dates as ISO strings for stability
 *   - Tags joined by comma
 *   - Stable column order, never random
 */
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { stringify as csvStringify } from 'csv-stringify/sync';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { CustomerService, type CustomerFilters } from './CustomerService.js';
import { toMoroccanLocal } from './phone.js';
import { resolveContactPhone } from '../lib/jid.js';

export const EXPORT_COLUMNS = [
  'customer_id',
  'full_name',
  'phone',
  'whatsapp_account_name',
  'whatsapp_account_id',
  'bot_name',
  'status',
  'tags',
  'city',
  'address',
  'source',
  'campaign_name',
  'first_message_at',
  'last_message_at',
  'last_incoming_message',
  'last_outgoing_message',
  'total_messages',
  'bot_paused',
  'current_step',
  'last_bot_step',
  'order_status',
  'order_quantity',
  'order_total',
  'notes',
  'follow_up_status',
  'next_follow_up_at',
  'created_at',
  'updated_at',
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

const COLUMN_WIDTHS: Partial<Record<ExportColumn, number>> = {
  customer_id: 18,
  full_name: 22,
  phone: 18,
  whatsapp_account_name: 18,
  whatsapp_account_id: 18,
  bot_name: 18,
  status: 12,
  tags: 24,
  city: 14,
  address: 30,
  source: 16,
  campaign_name: 18,
  first_message_at: 22,
  last_message_at: 22,
  last_incoming_message: 22,
  last_outgoing_message: 22,
  total_messages: 12,
  bot_paused: 10,
  current_step: 22,
  last_bot_step: 22,
  order_status: 14,
  order_quantity: 12,
  order_total: 12,
  notes: 30,
  follow_up_status: 14,
  next_follow_up_at: 22,
  created_at: 22,
  updated_at: 22,
};

const fmtDate = (d: Date | null | undefined): string => d ? d.toISOString() : '';
const parseTags = (s: string | null): string[] => {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
};

interface ExportRow {
  customer_id: string;
  full_name: string;
  phone: string;
  whatsapp_account_name: string;
  whatsapp_account_id: string;
  bot_name: string;
  status: string;
  tags: string;
  city: string;
  address: string;
  source: string;
  campaign_name: string;
  first_message_at: string;
  last_message_at: string;
  last_incoming_message: string;
  last_outgoing_message: string;
  total_messages: number;
  bot_paused: string;
  current_step: string;
  last_bot_step: string;
  order_status: string;
  order_quantity: string;
  order_total: string;
  notes: string;
  follow_up_status: string;
  next_follow_up_at: string;
  created_at: string;
  updated_at: string;
}

async function buildRows(filters: CustomerFilters, limit?: number): Promise<ExportRow[]> {
  const where = CustomerService.compileWhere(filters);
  const items = await prisma.contact.findMany({
    where,
    include: {
      account: { select: { id: true, name: true } },
      orders: { orderBy: { createdAt: 'desc' }, take: 1 },
      followUpLogs: { orderBy: { scheduledAt: 'asc' }, where: { status: 'pending' }, take: 1 },
      _count: { select: { messages: true } },
    },
    orderBy: [{ createdAt: 'asc' }],
    ...(limit ? { take: limit } : {}),
  });

  // For "last bot step" we need the BotStep title — fetch in batch
  const stepIds = Array.from(new Set(items.flatMap((c) => [c.currentStepId].filter(Boolean) as string[])));
  const steps = stepIds.length
    ? await prisma.botStep.findMany({ where: { id: { in: stepIds } }, select: { id: true, title: true, botId: true } })
    : [];
  const stepMap = new Map(steps.map((s) => [s.id, s]));

  // Pick a "linked" bot per contact: the highest-priority active bot on the account
  const accountBotMap = new Map<string, string>();
  const accountIds = Array.from(new Set(items.map((c) => c.accountId)));
  if (accountIds.length) {
    const links = await prisma.botAccount.findMany({
      where: { accountId: { in: accountIds } },
      include: { bot: { select: { id: true, name: true, isActive: true, priority: true } } },
    });
    for (const accId of accountIds) {
      const candidates = links.filter((l) => l.accountId === accId && l.bot.isActive);
      candidates.sort((a, b) => b.bot.priority - a.bot.priority);
      if (candidates[0]) accountBotMap.set(accId, candidates[0].bot.name);
    }
  }

  return items.map<ExportRow>((c) => {
    const order = c.orders[0];
    const fu = c.followUpLogs[0];
    const curStep = c.currentStepId ? stepMap.get(c.currentStepId) : null;
    return {
      customer_id: c.id,
      full_name: c.name ?? '',
      // Real phone: prefer contact.phoneJid (populated from Baileys senderPn
      // when the routing jid is @lid). Never fabricate from LID digits — the
      // operator used to see 14-digit LIDs like "228303298424989" leaking into
      // the spreadsheet. When unknown, leave the column empty.
      phone: (() => {
        const raw = resolveContactPhone({ jid: c.jid, phoneJid: (c as any).phoneJid });
        return raw ? (toMoroccanLocal(raw) ?? raw) : '';
      })(),
      whatsapp_account_name: c.account?.name ?? '',
      whatsapp_account_id: c.accountId,
      bot_name: accountBotMap.get(c.accountId) ?? '',
      status: c.status,
      tags: parseTags(c.tags).join(', '),
      city: c.city ?? '',
      address: c.address ?? '',
      source: c.source ?? '',
      campaign_name: c.campaignName ?? '',
      first_message_at: fmtDate(c.firstMessageAt),
      last_message_at: fmtDate(c.lastInteractionAt),
      last_incoming_message: fmtDate(c.lastIncomingMessageAt),
      last_outgoing_message: fmtDate(c.lastOutgoingMessageAt),
      total_messages: c._count.messages,
      bot_paused: c.botPaused ? 'yes' : 'no',
      current_step: curStep?.title ?? '',
      last_bot_step: curStep?.title ?? '',
      order_status: order?.status ?? '',
      order_quantity: order?.quantity ?? '',
      order_total: '',
      notes: c.notes ?? '',
      follow_up_status: fu ? 'pending' : '',
      next_follow_up_at: fu ? fmtDate(fu.scheduledAt) : '',
      created_at: fmtDate(c.createdAt),
      updated_at: fmtDate(c.lastInteractionAt ?? c.createdAt),
    };
  });
}

export const CustomerExportService = {
  EXPORT_COLUMNS,

  /** Lightweight count + first-row preview so the UI can show "Export 50 contacts?" */
  async preview(filters: CustomerFilters, limit?: number) {
    const total = await CustomerService.count(filters);
    const sample = await buildRows(filters, Math.min(5, limit ?? total));
    return { total, sample };
  },

  /**
   * Build an Excel file and return its on-disk path. The caller (route)
   * will stream the file back and clean up afterwards.
   */
  async exportExcel(filters: CustomerFilters, columns: ExportColumn[], limit?: number): Promise<{ path: string; total: number; fileName: string }> {
    const rows = await buildRows(filters, limit);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Bot Said 22';
    wb.created = new Date();
    const ws = wb.addWorksheet('Customers', {
      views: [{ state: 'frozen', ySplit: 1 }],  // freeze header
    });

    // Configure columns
    ws.columns = columns.map((key) => ({
      header: key,
      key,
      width: COLUMN_WIDTHS[key] ?? 18,
    }));

    // Header style: bold + light fill
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F9D55' } };
    header.alignment = { vertical: 'middle' };
    header.height = 22;

    // Force phone column to text
    const phoneCol = ws.getColumn('phone');
    if (phoneCol) phoneCol.numFmt = '@';

    // Append rows
    for (const r of rows) {
      const rowData: Record<string, unknown> = {};
      for (const col of columns) rowData[col] = (r as any)[col];
      ws.addRow(rowData);
    }

    // Auto-filter
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };

    // Write to disk
    const dir = path.join(env.STORAGE_ROOT, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `customers_${Date.now()}.xlsx`;
    const filePath = path.join(dir, fileName);
    await wb.xlsx.writeFile(filePath);
    return { path: filePath, total: rows.length, fileName };
  },

  /** CSV export — phone column will be quoted by csv-stringify automatically. */
  async exportCsv(filters: CustomerFilters, columns: ExportColumn[], limit?: number): Promise<{ path: string; total: number; fileName: string }> {
    const rows = await buildRows(filters, limit);
    const out = csvStringify(
      rows.map((r) => columns.map((c) => (r as any)[c])),
      { header: true, columns: columns as unknown as string[] },
    );
    const dir = path.join(env.STORAGE_ROOT, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `customers_${Date.now()}.csv`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, '﻿' + out, 'utf8');  // BOM for Excel UTF-8 compatibility
    return { path: filePath, total: rows.length, fileName };
  },
};
