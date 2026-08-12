/**
 * One-time backfill: populate Contact.firstMessageAt / lastIncoming / lastOutgoing
 * / lastInteractionAt from existing Message rows. Idempotent — safe to re-run.
 *
 * Usage: npx tsx prisma/backfill.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const contacts = await prisma.contact.findMany({ select: { id: true } });
  console.log(`Backfilling ${contacts.length} contacts…`);

  let done = 0;
  for (const c of contacts) {
    const [first, lastIn, lastOut] = await Promise.all([
      prisma.message.findFirst({
        where: { contactId: c.id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true },
      }),
      prisma.message.findFirst({
        where: { contactId: c.id, direction: 'in' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      }),
      prisma.message.findFirst({
        where: { contactId: c.id, direction: 'out' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      }),
    ]);

    const lastInter = [lastIn?.createdAt, lastOut?.createdAt]
      .filter(Boolean)
      .sort((a, b) => (b as Date).getTime() - (a as Date).getTime())[0] ?? null;

    await prisma.contact.update({
      where: { id: c.id },
      data: {
        firstMessageAt: first?.createdAt ?? null,
        lastIncomingMessageAt: lastIn?.createdAt ?? null,
        lastOutgoingMessageAt: lastOut?.createdAt ?? null,
        lastInteractionAt: lastInter as Date | null,
      },
    });
    done++;
  }

  // Stamp a senderType on existing messages so the inbox can label old ones.
  // We can't know admin vs bot from old rows; tag any 'out' as 'bot' (best guess
  // since previously all outs were bot). Admin will write new ones with senderType='admin'.
  const upd = await prisma.$executeRawUnsafe(
    `UPDATE Message SET senderType = CASE WHEN direction='in' THEN 'customer' ELSE 'bot' END WHERE senderType IS NULL`
  );
  console.log(`✓ ${done} contacts backfilled`);
  console.log(`✓ ${upd} messages tagged with senderType`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
