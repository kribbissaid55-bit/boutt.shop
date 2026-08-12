/**
 * OrderService — manages the small state machine that collects an order.
 * State lives on Contact.metadata.order = { fields: {...}, currentField, askedAt }.
 * Six fields in order: fullName, phone, city, address, quantity, notes.
 */
import { prisma } from '../lib/prisma.js';
import type { Contact } from '@prisma/client';

export const ORDER_FIELDS = ['fullName', 'phone', 'city', 'address', 'quantity', 'notes'] as const;
export type OrderField = (typeof ORDER_FIELDS)[number];

export interface OrderState {
  fields: Partial<Record<OrderField, string>>;
  currentField?: OrderField;
  awaitingConfirmation?: boolean;
}

export const ORDER_QUESTIONS_AR: Record<OrderField, string> = {
  fullName: 'باش نوجد لك الطلب، عافاك شنو هو الاسم ديالك؟',
  phone:    'شكرا. عطينا رقم الهاتف ديالك للتواصل:',
  city:     'فأي مدينة كنتي؟',
  address:  'العنوان بالتفصيل عافاك:',
  quantity: 'شحال من قطعة بغيتي تطلب؟',
  notes:    'واش كاينة شي ملاحظة زائدة؟ (اكتب "لا" إلا ما كاينش)',
};

const readMeta = (c: Contact): any => {
  if (!c.metadata) return {};
  try { return JSON.parse(c.metadata); } catch { return {}; }
};
const writeMeta = (c: Contact, meta: any) => JSON.stringify(meta);

export const OrderService = {
  getState(c: Contact): OrderState | null {
    const m = readMeta(c);
    return m.order ?? null;
  },

  async start(contactId: string): Promise<OrderState> {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    const meta = readMeta(c);
    meta.order = { fields: {}, currentField: 'fullName' as OrderField } satisfies OrderState;
    await prisma.contact.update({ where: { id: contactId }, data: { metadata: writeMeta(c, meta) } });
    return meta.order;
  },

  /** Save the answer for the current field, advance to the next. */
  async answer(contactId: string, value: string): Promise<{ next?: OrderField; done: boolean; state: OrderState }> {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    const meta = readMeta(c);
    const state = (meta.order ?? { fields: {} }) as OrderState;
    const cur = state.currentField;
    if (!cur) {
      state.awaitingConfirmation = true;
      meta.order = state;
      await prisma.contact.update({ where: { id: contactId }, data: { metadata: writeMeta(c, meta) } });
      return { done: true, state };
    }
    state.fields[cur] = value.trim();
    const idx = ORDER_FIELDS.indexOf(cur);
    const next = ORDER_FIELDS[idx + 1];
    if (next) {
      state.currentField = next;
      meta.order = state;
      await prisma.contact.update({ where: { id: contactId }, data: { metadata: writeMeta(c, meta) } });
      return { next, done: false, state };
    }
    state.currentField = undefined;
    state.awaitingConfirmation = true;
    meta.order = state;
    await prisma.contact.update({ where: { id: contactId }, data: { metadata: writeMeta(c, meta) } });
    return { done: true, state };
  },

  buildSummaryAr(state: OrderState): string {
    const f = state.fields;
    return [
      'هذا هو الطلب ديالك:',
      `الاسم: ${f.fullName ?? '-'}`,
      `الهاتف: ${f.phone ?? '-'}`,
      `المدينة: ${f.city ?? '-'}`,
      `العنوان: ${f.address ?? '-'}`,
      `الكمية: ${f.quantity ?? '-'}`,
      `ملاحظات: ${f.notes ?? '-'}`,
      '',
      'واش نأكد الطلب؟',
      '1 - نعم أكد الطلب',
      '2 - لا بغيت نعدل المعلومات',
    ].join('\n');
  },

  async confirm(contactId: string, botId: string): Promise<{ orderId: string }> {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    const meta = readMeta(c);
    const state = (meta.order ?? { fields: {} }) as OrderState;
    const order = await prisma.order.create({
      data: {
        contactId, botId,
        fullName: state.fields.fullName ?? null,
        phone:    state.fields.phone ?? null,
        city:     state.fields.city ?? null,
        address:  state.fields.address ?? null,
        quantity: state.fields.quantity ?? null,
        notes:    state.fields.notes ?? null,
        status:   'confirmed',
      },
    });
    delete meta.order;
    await prisma.contact.update({
      where: { id: contactId },
      data: { metadata: writeMeta(c, meta), status: 'ordered' },
    });
    return { orderId: order.id };
  },

  async cancel(contactId: string) {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    const meta = readMeta(c);
    delete meta.order;
    await prisma.contact.update({
      where: { id: contactId },
      data: { metadata: writeMeta(c, meta) },
    });
  },
};
