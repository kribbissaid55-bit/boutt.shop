// PM2 ecosystem config for Bot Said 22.
//
// Baileys keeps stateful in-memory WhatsApp sessions per account, so this
// process MUST NOT be clustered — one instance per host. Restart-on-crash and
// memory ceiling handle recovery without invalidating auth state.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup       # to persist across reboots
//   pm2 logs bsa-server
//   pm2 restart bsa-server

module.exports = {
  apps: [
    {
      name: 'bsa-server',
      cwd: './server',
      script: 'npm',
      args: 'run start',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '../logs/pm2-server-err.log',
      out_file: '../logs/pm2-server-out.log',
      merge_logs: true,
      time: true,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
