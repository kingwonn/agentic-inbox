// pm2 ecosystem file (cross-platform alternative to systemd/launchd).
//   npm i -g pm2
//   pm2 start deploy/pm2.config.cjs
//   pm2 save && pm2 startup        # start on boot
//   pm2 logs taskcenter
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "taskcenter",
      cwd: path.resolve(__dirname, ".."),
      script: "bin/tc.mjs",
      args: "daemon",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1, // single instance only (data/taskcenter.lock enforces it)
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      kill_timeout: 45000, // graceful stop window (SIGTERM → runs finish or abort after 30s)
      env: { NODE_ENV: "production", TC_LOG_LEVEL: "info" },
      out_file: path.resolve(__dirname, "..", "data", "logs", "pm2.out.log"),
      error_file: path.resolve(__dirname, "..", "data", "logs", "pm2.err.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
