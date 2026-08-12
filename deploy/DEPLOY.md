# دليل نشر Bot Said 22

هذا الدليل يشرح طريقتين لنشر الموقع على الإنترنت — VPS مباشر أو Docker. اختر واحدة، الاثنين مدعومتين من نفس الحزمة.

---

## 🚀 بداية سريعة على Hostinger VPS

هذا القسم يخصّ من اختار Hostinger — الطريقة الأكثر مباشرة للنشر. باقي الدليل بعد هذا يخدم على أي VPS Linux.

### الخطوة 0 — تحضير VPS في Hostinger

1. **اشترِ VPS**: خطة **KVM 1** كافية (1 vCPU + 4 GB RAM + 50 GB NVMe). تتحمّل آلاف الرسائل يومياً بسلاسة.
2. **اختر Ubuntu 24.04 LTS** أثناء التثبيت (أو Ubuntu 22.04). إذا اخترت "LAMP stack" أو أي قالب آخر، اعمل **Reinstall OS** إلى Ubuntu نظيف من hPanel → VPS → **Operating System**.
3. **SSH Access**: hPanel → VPS → **SSH Access**. احفظ:
   - **IP العام** ديال الخادم
   - كلمة المرور (أو أضف SSH key من نفس الصفحة — أكثر أماناً)
4. **Firewall**: hPanel → VPS → **Firewall**. تأكد أن هذه المنافذ مفتوحة:
   - **22** (SSH)
   - **80** (HTTP)
   - **443** (HTTPS)
   المنفذ 4000 يبقى **مغلق للخارج** — nginx يوجّه له داخلياً.
5. **الدومين**: من مسجّل الدومين ديالك (Namecheap, GoDaddy, Hostinger domains…)، أضف:
   - **A record**: `@` → `IP الـ VPS`
   - **A record** (اختياري): `www` → نفس IP
   انتظر 5-30 دقيقة حتى ينتشر DNS.

### الخطوة 1 — رفع الحزمة إلى VPS

من جهازك المحلي (الـ Mac):
```bash
# استبدل <IP> بالـ IP ديال VPS، و<تاريخ> بالتاريخ في اسم الملف
scp ~/Desktop/bot-said-22-deploy-<تاريخ>.tar.gz root@<IP>:/tmp/

# اتصل بالخادم
ssh root@<IP>
```

### الخطوة 2 — التثبيت التلقائي

على الخادم:
```bash
sudo mkdir -p /opt
sudo tar -xzf /tmp/bot-said-22-deploy-*.tar.gz -C /opt/
cd /opt/bot-said-22
bash deploy/install-vps.sh
```

السكريبت يطلب منك اسم المستخدم وكلمة المرور للأدمن — أدخلهما، والباقي أوتوماتيكي (Node ≥ 20، تثبيت التبعيات، ضبط قاعدة البيانات، توليد الأسرار).

### الخطوة 3 — تشغيل الخدمة + nginx + HTTPS

تابع القسم **A** أدناه من الخطوة 5 (pm2 أو systemd)، ثم الخطوة 6 (nginx)، ثم الخطوة 7 (Let's Encrypt HTTPS). كلها تخدم على Hostinger بدون تعديل.

### 💡 نصائح خاصة بـ Hostinger

- **Snapshots**: قبل أي تحديث كبير، خذ Snapshot من **hPanel → VPS → Snapshots**. يرجعك للخلف في دقيقة إذا وقع شي مشكل.
- **VPS Monitor**: راقب الرسم البياني للـ CPU/RAM في hPanel أول 24 ساعة — للتأكد من الاستقرار قبل ما تربط عدة حسابات WhatsApp.
- **Reverse DNS (PTR)**: hPanel → VPS → **Reverse DNS**. اضبطه على دومينك — يحسّن سمعة الخادم إذا أضفت لاحقاً إشعارات email للأدمن.
- **Automatic Backups**: فعّل خيار "Weekly Backups" من hPanel — طبقة أمان إضافية فوق `deploy/backup-db.sh`.

---

## قبل ما تبدأ

- **خادم Linux**: Ubuntu 22.04 أو Debian 12 (أو أي توزيعة حديثة).
- **دومين**: يشير للـ IP ديال الخادم (A record).
- **الحد الأدنى للموارد**: 1 CPU + 1 GB RAM + 10 GB disk. الموقع خفيف — هذا يكفي لمئات العملاء.
- **منافذ مفتوحة**: 80 و 443 على الجدار الناري. المنفذ 4000 يبقى داخلي (nginx يوجّه له).

---

## الطريقة A — VPS مع pm2 أو systemd (موصى بها)

### 1. رفع الحزمة

من جهازك المحلي:
```bash
scp bot-said-22-deploy-YYYYMMDD.tar.gz user@your.vps.ip:/tmp/
```

اتصل بالخادم عبر SSH:
```bash
ssh user@your.vps.ip
```

### 2. فك الضغط في `/opt/bot-said-22`

```bash
sudo mkdir -p /opt
sudo tar -xzf /tmp/bot-said-22-deploy-*.tar.gz -C /opt/
sudo chown -R $USER:$USER /opt/bot-said-22
cd /opt/bot-said-22
```

### 3. تثبيت Node.js (إن لم يكن مثبتاً)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

تحقق: `node -v` يجب أن يعطي `v20.x.x` أو أعلى.

### 4. تشغيل المثبّت التلقائي

```bash
bash deploy/install-vps.sh
```

هذا السكريبت:
- يتأكد من إصدار Node
- ينشئ `.env` من القالب ويولد `JWT_SECRET` و `AI_KEY_SECRET` عشوائياً
- يطلب منك اسم المستخدم وكلمة المرور للأدمن
- يشغّل `npm ci` لتحميل التبعيات
- يزامن قاعدة البيانات ويخلق حساب الأدمن

### 5. تشغيل الخدمة — اختر واحدة

**A) pm2 (أسهل)**
```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # يطبع أمراً — انسخه وشغّله كـ sudo
```

**B) systemd (أصلي)**
```bash
sudo cp deploy/systemd/bot-said-22.service /etc/systemd/system/
sudo sed -i "s|/opt/bot-said-22|$(pwd)|g" /etc/systemd/system/bot-said-22.service
sudo systemctl daemon-reload
sudo systemctl enable --now bot-said-22
sudo journalctl -fu bot-said-22    # للمتابعة
```

### 6. تثبيت nginx كواجهة عامة

```bash
sudo apt-get install -y nginx
sudo cp deploy/nginx/bot-said-22.conf.sample /etc/nginx/sites-available/bot-said-22.conf
sudo nano /etc/nginx/sites-available/bot-said-22.conf
# غيّر:
#   server_name → your.domain.com
#   root        → /opt/bot-said-22/client/dist
sudo ln -s /etc/nginx/sites-available/bot-said-22.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # (اختياري) لحذف الصفحة الافتراضية
sudo nginx -t
sudo systemctl reload nginx
```

اختبار: `curl http://your.domain.com/api/health` يعطي `{"ok":true,...}`.

### 7. HTTPS مع Let's Encrypt (شبه إلزامي)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com
```

certbot يعدّل nginx تلقائياً + يضيف تجديد مجدول. الموقع الآن على `https://your.domain.com`.

---

## الطريقة B — Docker + docker-compose

### 1. تثبيت Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # اخرج ثم عد للاتصال
```

### 2. رفع + فك الحزمة (نفس الخطوات 1 و 2 أعلاه).

### 3. تجهيز `.env`

```bash
cp deploy/.env.production.example .env
nano .env
# املأ: JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, AI_KEY_SECRET
# (استعمل: openssl rand -hex 32 لتوليد كل واحد)
```

### 4. بناء + تشغيل

```bash
mkdir -p storage data
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

المنفذ 4000 مربوط على 127.0.0.1 داخل المضيف. nginx يوجّه له مثل الطريقة A.

### 5. nginx + HTTPS (نفس الخطوتين 6 و 7 من الطريقة A).

---

## أول تسجيل دخول

1. افتح `https://your.domain.com`
2. سجّل الدخول بـ `ADMIN_USERNAME` و `ADMIN_PASSWORD` من `.env`
3. **⚠ مهم**: افتح فوراً **الإعدادات → «الحساب والفريق» → «تغيير كلمة المرور»** وضع كلمة مرور جديدة قوية. كلمة المرور اللي في `.env` هي فقط للتشغيل الأول.

---

## نسخ احتياطية

سكريبت جاهز:
```bash
bash deploy/backup-db.sh
```

يعمل نسخة من `server/prisma/dev.db` مع طابع زمني إلى `backups/`. يمكن ربطه بـ cron:
```bash
crontab -e
# نسخة كل يوم على الساعة 3 فجراً:
0 3 * * * cd /opt/bot-said-22 && bash deploy/backup-db.sh >> /var/log/bsa-backup.log 2>&1
```

**احتفظ أيضاً بمجلد `storage/`** — يحتوي الوسائط + جلسات WhatsApp. فقدانه = إعادة مسح كل QR code.

---

## نقل من تثبيت قديم

إذا كنت تنقل بيانات من نسخة سابقة، بعد فك الحزمة وقبل `install-vps.sh`:
```bash
# على الخادم القديم:
tar -czf /tmp/bsa-data.tgz server/prisma/dev.db storage/
scp /tmp/bsa-data.tgz user@new.vps.ip:/tmp/

# على الخادم الجديد:
cd /opt/bot-said-22
tar -xzf /tmp/bsa-data.tgz
bash deploy/install-vps.sh    # آمن — لن يمسح البيانات المنقولة
```

---

## استكشاف الأخطاء

| العرض | السبب المحتمل | الحل |
|---|---|---|
| `curl /api/health` يعطي 502 | الخدمة متوقفة | `pm2 status` أو `systemctl status bot-said-22` |
| صفحة بيضاء بعد nginx | `root` خطأ في nginx.conf | تحقق أن `/opt/bot-said-22/client/dist/index.html` موجود |
| `bind: address already in use` | خدمة أخرى على 4000 | `sudo lsof -i:4000` — أوقف أو غيّر PORT في `.env` |
| Login "invalid_credentials" | كلمة مرور غير صحيحة | لا تعدّل الأدمن يدوياً في DB — أعد تشغيل `install-vps.sh` |
| Rate limit "too_many_attempts" | 10 محاولات فاشلة في 15 دقيقة | انتظر أو أعد تشغيل الخدمة |
| WhatsApp لا يتصل | QR منتهي أو fresh session | افتح صفحة "الحسابات" وامسح QR جديد |

سجلات:
- pm2: `pm2 logs bsa-server`
- systemd: `journalctl -fu bot-said-22`
- Docker: `docker compose -f deploy/docker-compose.yml logs -f`
- nginx: `sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log`

---

## تحديثات لاحقة

عند وصول نسخة جديدة (tarball جديد):
```bash
# أوقف الخدمة
pm2 stop bsa-server   # أو: sudo systemctl stop bot-said-22

# احفظ نسخة من البيانات الحية
bash deploy/backup-db.sh

# فك الحزمة الجديدة فوق القديمة (لن تمس .env ولا storage/ ولا dev.db)
sudo tar -xzf /tmp/bot-said-22-deploy-NEW.tar.gz -C /opt/ --skip-old-files=no --keep-newer-files
cd /opt/bot-said-22

# نفّذ التحديث
bash deploy/install-vps.sh   # سيحدّث DB schema إن لزم + تبعيات جديدة

# أعد التشغيل
pm2 restart bsa-server   # أو: sudo systemctl start bot-said-22
```

---

## أسئلة شائعة

**س: هل SQLite تكفي في الإنتاج؟**
ج: نعم — لآلاف العملاء وعشرات آلاف الرسائل. الأداء ممتاز مع WAL + `busy_timeout` المفعّلين أصلاً. إذا احتجت للتوسع لاحقاً، بدّل `provider` في `server/prisma/schema.prisma` إلى `postgresql` وحدّث `DATABASE_URL`.

**س: هل يجب استخدام HTTPS؟**
ج: نعم بشكل قاطع. cookies الجلسة تحمل مصادقة الأدمن — بدون HTTPS، أي مستخدم على نفس الشبكة يقدر يسرقها.

**س: كم يستهلك من الذاكرة؟**
ج: عادة 100-300 MB. حددنا سقف 512 MB في pm2/systemd؛ إذا تخطاه، إعادة تشغيل تلقائية.

**س: هل يمكن ربط أكثر من رقم WhatsApp؟**
ج: نعم — من صفحة "الحسابات" أضف حسابات إضافية. كل حساب يفتح جلسة Baileys مستقلة.

**س: كيف أنقل موقعي لخادم آخر؟**
ج: انظر قسم "نقل من تثبيت قديم" أعلاه — انسخ `dev.db` و `storage/` فقط، أعد التشغيل.
