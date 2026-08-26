# WhatsApp Cloud API (الرسمي) — البنية والتشغيل

> تكامل **رسمي** مع Meta WhatsApp Cloud API (Graph v23.0)، يعمل جنباً إلى جنب مع
> Baileys القديم خلف عمود `WhatsAppAccount.provider` — التراجع = تعديل صف واحد.

## البنية

- `services/CloudApiService.ts` — الطبقة الوحيدة التي تكلّم graph.facebook.com
  (إرسال نص/وسائط/أزرار/قوائم/قوالب، تنزيل وسائط واردة، markRead، أرقام WABA،
  subscribe، templates). التوكن وApp Secret محفوظان **مشفرين AES-256-GCM** في جدول
  Setting (`wa_cloud_token_enc`, `wa_cloud_app_secret_enc`).
- `adapters/whatsapp/CloudApiProvider.ts` — ينفذ نفس واجهة `BotProvider`؛ المحرك
  (بوتات، ذكاء اصطناعي، حملات، متابعات، صندوق) لم يتغير.
- `adapters/whatsapp/providerFactory.ts` — `providerFor(accountId)` يختار
  Baileys أو Cloud حسب `provider` في صف الحساب (كاش 60 ثانية).
  + `markReadFor` و`isDeliverable` و`canSendFreeForm` (فحص نافذة 24 ساعة).
- `http/routes/whatsappWebhook.routes.ts` — ويبهوك عام
  `/api/whatsapp/webhook`: تحقق hub.challenge، توقيع HMAC-SHA256، ack سريع،
  معالجة غير متزامنة، تحويل الرسائل إلى نفس شكل `IncomingMessage`، وتحديث حالات
  التسليم (sent/delivered/read/failed) على جدول Message.
- `http/routes/whatsappCloud.routes.ts` — إعدادات محمية بالجلسة: `/api/wa-cloud/*`.
- الواجهة: صفحة **"واتساب الرسمي"** `/wa-cloud` — الإعداد، الويبهوك، تفعيل
  الأرقام، إرسال تجريبي، ودليل خطوة-بخطوة كامل.

## قاعدة البيانات (إضافات فقط — بدون هدم)

`WhatsAppAccount`: `provider` (baileys|cloud، افتراضي baileys)،
`phoneNumberId` (فريد)، `wabaId`. تُطبق تلقائياً عند الإقلاع (`prisma db push`).

## قواعد Meta (لا يستطيع الكود تجاوزها)

- **نافذة 24 ساعة**: الرسائل الحرة تصل فقط خلال 24س من آخر رسالة من العميل.
  خارجها: قوالب معتمدة فقط (خطأ 131047). الحملات/المتابعات تتخطى جهات الاتصال
  خارج النافذة بسبب واضح `outside_24h_window_use_template`.
- **رقم الاختبار** يرسل فقط لمستلمين مضافين في لوحة Meta. الإرسال بلا قيود
  يتطلب Business Verification (خطوة يدوية في Business Manager).
- الواجهة الرسمية **لا تجعل الرقم محصناً** — Meta تراقب الجودة (quality rating).

## الصلاحيات المطلوبة للتوكن (فقط)

`whatsapp_business_messaging` + `whatsapp_business_management`.

## التراجع (rollback)

- حساب واحد: حدّث `provider='baileys'` في صف الحساب — يسري فوراً.
- Baileys لم يُحذف؛ كل مساراته سليمة حتى يثبت المسار الرسمي بالكامل.
