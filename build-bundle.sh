#!/usr/bin/env bash
# =============================================================================
# Bot Said 22 — build a ready-to-upload deployment tarball.
#
# Output: ~/Desktop/bot-said-22-deploy-YYYYMMDD.tar.gz
#
# Contents: server/dist + client/dist + prisma + package.json(s) + deploy/*.
# Excludes node_modules, storage/, backups/, dev.db, session dirs.
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo -e "${GRN}▶ Rebuilding server${NC}"
(cd server && npm run build)

echo -e "${GRN}▶ Rebuilding client${NC}"
(cd client && npm run build)

STAGE="$(mktemp -d -t bsa-bundle-XXXXXX)"
DEST_DIR="$STAGE/bot-said-22"
mkdir -p "$DEST_DIR"

echo -e "${GRN}▶ Staging bundle at $STAGE${NC}"

# --- Server (compiled + manifest + prisma) ---
mkdir -p "$DEST_DIR/server"
cp -R server/dist         "$DEST_DIR/server/dist"
cp    server/package.json "$DEST_DIR/server/package.json"
# tsconfig lets the fallback seed path (`npx tsx prisma/seed.ts`) work.
cp    server/tsconfig.json "$DEST_DIR/server/tsconfig.json"
# Prisma schema + seed only. Never ship dev.db.
mkdir -p "$DEST_DIR/server/prisma"
cp    server/prisma/schema.prisma "$DEST_DIR/server/prisma/schema.prisma"
cp    server/prisma/seed.ts       "$DEST_DIR/server/prisma/seed.ts"
if [ -f server/package-lock.json ]; then
  cp server/package-lock.json "$DEST_DIR/server/package-lock.json"
fi

# --- Client (built SPA) ---
mkdir -p "$DEST_DIR/client"
cp -R client/dist         "$DEST_DIR/client/dist"
# Ship package.json so anyone can rebuild the SPA locally if needed.
cp    client/package.json "$DEST_DIR/client/package.json"
if [ -f client/package-lock.json ]; then
  cp client/package-lock.json "$DEST_DIR/client/package-lock.json"
fi

# --- Root workspace files ---
cp package.json      "$DEST_DIR/package.json"
[ -f package-lock.json ] && cp package-lock.json "$DEST_DIR/package-lock.json"
[ -f ecosystem.config.cjs ] && cp ecosystem.config.cjs "$DEST_DIR/ecosystem.config.cjs"
[ -f README.md ] && cp README.md "$DEST_DIR/README.md"

# --- Deploy scaffolding ---
cp -R deploy "$DEST_DIR/deploy"

# Ship a placeholder .env at the root (a copy of the production template) so
# a first-time operator sees the layout even before running install-vps.sh.
cp deploy/.env.production.example "$DEST_DIR/.env.example"

# Storage dir stub so the app finds it on first boot.
mkdir -p "$DEST_DIR/storage/media" "$DEST_DIR/storage/sessions"
touch    "$DEST_DIR/storage/.gitkeep"

# --- Archive ---
DATE=$(date +%Y%m%d)
DESK="${HOME}/Desktop"
mkdir -p "$DESK"
OUT="$DESK/bot-said-22-deploy-$DATE.tar.gz"

echo -e "${GRN}▶ Creating $OUT${NC}"
tar -czf "$OUT" -C "$STAGE" bot-said-22

SIZE=$(du -h "$OUT" | cut -f1)
FILES=$(tar -tzf "$OUT" | wc -l | tr -d ' ')

echo
echo -e "${GRN}✔ Bundle ready.${NC}"
echo "  Path:   $OUT"
echo "  Size:   $SIZE"
echo "  Files:  $FILES"
echo
echo "Upload to your server:"
echo -e "  ${YLW}scp \"$OUT\" user@your.vps.ip:/tmp/${NC}"
echo
echo "Then on the server:"
echo -e "  ${YLW}sudo tar -xzf /tmp/$(basename "$OUT") -C /opt/${NC}"
echo -e "  ${YLW}cd /opt/bot-said-22 && bash deploy/install-vps.sh${NC}"
echo
echo "Full guide inside the bundle: deploy/DEPLOY.md"

# Clean up stage.
rm -rf "$STAGE"
