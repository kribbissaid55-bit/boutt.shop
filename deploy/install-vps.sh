#!/usr/bin/env bash
# =============================================================================
# Bot Said 22 — one-shot VPS installer.
#
# Run from the extracted project root:
#   cd /opt/bot-said-22 && bash deploy/install-vps.sh
#
# Idempotent: re-running is safe. Existing .env values are preserved; missing
# ones are prompted for or generated.
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'

# Resolve project root (parent of the deploy/ dir this script lives in).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

echo -e "${GRN}▶ Bot Said 22 installer${NC}"
echo "   project root: $ROOT"
echo

# ---------------------------------------------------------------------------
# 1. Node.js >= 20 gate. Baileys requires it.
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}✗ Node.js not found. Install Node.js ≥ 20 first:${NC}"
  echo "   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "   sudo apt-get install -y nodejs"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${RED}✗ Node.js version $(node -v) is too old (< 20). Upgrade first.${NC}"
  exit 1
fi
echo -e "${GRN}✓ Node.js $(node -v)${NC}"

# ---------------------------------------------------------------------------
# 2. Ensure .env exists at project root. Copy from template if missing,
#    generate random secrets in place.
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
  echo -e "${YLW}→ .env missing — creating from deploy/.env.production.example${NC}"
  cp deploy/.env.production.example .env
fi

# Helper: replace the value for KEY in .env, but only if the current value
# is empty or matches the placeholder REPLACE_ME_* pattern.
set_env_if_missing() {
  local key="$1"; local value="$2"
  local cur
  cur=$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)
  if [ -z "$cur" ] || echo "$cur" | grep -q "^REPLACE_ME"; then
    # Escape slashes + ampersands for sed.
    local esc
    esc=$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')
    if grep -qE "^${key}=" .env; then
      sed -i.bak "s|^${key}=.*|${key}=${esc}|" .env
    else
      printf '\n%s=%s\n' "$key" "$value" >> .env
    fi
    rm -f .env.bak
    return 0
  fi
  return 1
}

# JWT_SECRET + AI_KEY_SECRET — auto-generate if missing/placeholder.
if command -v openssl >/dev/null 2>&1; then
  if set_env_if_missing "JWT_SECRET" "$(openssl rand -hex 32)"; then
    echo -e "${GRN}✓ JWT_SECRET generated${NC}"
  fi
  if set_env_if_missing "AI_KEY_SECRET" "$(openssl rand -hex 32)"; then
    echo -e "${GRN}✓ AI_KEY_SECRET generated${NC}"
  fi
else
  echo -e "${YLW}⚠ openssl not found — leaving secrets as-is; edit .env manually${NC}"
fi

# ADMIN_USERNAME / ADMIN_PASSWORD — prompt if missing.
CUR_ADMIN_USER=$(grep -E "^ADMIN_USERNAME=" .env | head -1 | cut -d= -f2- || true)
if [ -z "$CUR_ADMIN_USER" ] || echo "$CUR_ADMIN_USER" | grep -q "^owner@yourdomain"; then
  read -rp "Admin username (email recommended): " ADMIN_USER
  set_env_if_missing "ADMIN_USERNAME" "$ADMIN_USER" || sed -i.bak "s|^ADMIN_USERNAME=.*|ADMIN_USERNAME=$ADMIN_USER|" .env && rm -f .env.bak
fi
CUR_ADMIN_PW=$(grep -E "^ADMIN_PASSWORD=" .env | head -1 | cut -d= -f2- || true)
if [ -z "$CUR_ADMIN_PW" ] || echo "$CUR_ADMIN_PW" | grep -q "^REPLACE_ME"; then
  read -rsp "Admin password (min 8 chars): " ADMIN_PW; echo
  set_env_if_missing "ADMIN_PASSWORD" "$ADMIN_PW" || sed -i.bak "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PW|" .env && rm -f .env.bak
fi

echo -e "${GRN}✓ .env ready${NC}"

# ---------------------------------------------------------------------------
# 3. Install production dependencies.
# ---------------------------------------------------------------------------
echo -e "${GRN}▶ Installing dependencies (may take 1–3 min)${NC}"
(cd server && npm ci --omit=dev)
# Root only needs npm-run-all if the operator uses the root scripts. Skip if
# there's no lockfile at root or if the workspaces install is already handled.
if [ -f package-lock.json ] && [ -f package.json ]; then
  npm ci --omit=dev --ignore-scripts || true
fi

# ---------------------------------------------------------------------------
# 4. Sync DB schema + seed the admin user.
# ---------------------------------------------------------------------------
echo -e "${GRN}▶ Syncing database schema${NC}"
(cd server && npx --yes prisma db push --schema=./prisma/schema.prisma --accept-data-loss=false)

echo -e "${GRN}▶ Seeding admin user${NC}"
# The seed script upserts. tsx is a devDep; we pull it via `npx --yes` on the
# fly (one-time download, cached afterwards) rather than requiring it in
# production deps.
(cd server && npx --yes tsx prisma/seed.ts)

# ---------------------------------------------------------------------------
# 5. Print next steps.
# ---------------------------------------------------------------------------
cat <<EOF

${GRN}✔ Install complete.${NC}

Next steps — pick ONE:

  ${YLW}A) Start with pm2${NC} (recommended, easy)
     sudo npm install -g pm2
     pm2 start ecosystem.config.cjs
     pm2 save && pm2 startup    # persist across reboots

  ${YLW}B) Start with systemd${NC} (native)
     sudo cp deploy/systemd/bot-said-22.service /etc/systemd/system/
     sudo sed -i "s|/opt/bot-said-22|$ROOT|g" /etc/systemd/system/bot-said-22.service
     sudo systemctl daemon-reload
     sudo systemctl enable --now bot-said-22

Then expose it publicly:

  sudo cp deploy/nginx/bot-said-22.conf.sample /etc/nginx/sites-available/bot-said-22.conf
  # Edit the file: set your domain + client/dist path
  sudo ln -s /etc/nginx/sites-available/bot-said-22.conf /etc/nginx/sites-enabled/
  sudo nginx -t && sudo systemctl reload nginx

For HTTPS (recommended):
  sudo apt-get install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d your.domain.com

Verify: curl http://127.0.0.1:4000/api/health   → {"ok":true,...}

${YLW}⚠ IMPORTANT:${NC} log in with the admin credentials from .env, then IMMEDIATELY
   change the password from Settings → «الحساب والفريق» so it's not tied to
   the .env file anymore.

EOF
