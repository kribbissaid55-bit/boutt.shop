import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient();

const DEFAULT_SETTINGS: Record<string, unknown> = {
  default_fallback_text: "عذرا، لم أفهم. اكتب 'menu' لعرض الخيارات. / Désolé, je n'ai pas compris. Tapez 'menu'.",
  welcome_enabled: true,
  bot_globally_enabled: true,
  media_text_delay_ms: 800,
  ignore_groups_default: true,
  per_contact_rate_per_min: 6,
  per_contact_rate_per_hour: 60,
  emergency_stop: false,
  typing_simulation: true,
  min_send_delay_ms: 1200,
  max_send_delay_ms: 3500,
  cold_start_ignore_seconds: 60,
  handover_keywords: [
    'بغيت نهضر مع شي واحد',
    'اتصل بيا',
    'موظف',
    'صاحب المحل',
    'parler à un humain',
    'agent',
  ],
  handover_message:
    'تم تحويلك إلى موظف، سنتواصل معك قريبا. / Vous serez contacté par un agent sous peu.',
  working_hours: { enabled: false, start: '09:00', end: '20:00', tz: 'Africa/Casablanca' },
};

async function main() {
  // Production admin credentials. Overridable via env vars for CI/staging.
  const username = process.env.ADMIN_USERNAME || 'kribbissaid55@gmail.com';
  const password = process.env.ADMIN_PASSWORD || 'HAjar//123';
  const passwordHash = await bcrypt.hash(password, 12);

  // Upsert on username: if this exact login exists we refresh its hash,
  // otherwise we create it. Also purge any legacy default `admin` account
  // so the platform can't be logged into with `admin/admin1234` after seed.
  await prisma.adminUser.deleteMany({
    where: { username: { in: ['admin'] }, NOT: { username } },
  });
  // Force owner + isActive on every seed so the seed account can never be
  // demoted or deactivated out of an owner state accidentally. If the operator
  // renames the owner in the DB, they must also update ADMIN_USERNAME.
  await prisma.adminUser.upsert({
    where: { username },
    update: { passwordHash, role: 'owner', isActive: true },
    create: { username, passwordHash, role: 'owner', isActive: true },
  });
  console.log(`✓ Admin user: ${username}`);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.setting.upsert({
      where: { key },
      update: {},
      create: { key, value: JSON.stringify(value) },
    });
  }
  console.log(`✓ ${Object.keys(DEFAULT_SETTINGS).length} default settings`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
