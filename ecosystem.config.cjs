/**
 * PM2 Ecosystem Configuration for Claude Telegram Bot
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 restart claude-telegram-bot
 *   pm2 logs claude-telegram-bot
 *   pm2 stop claude-telegram-bot
 *   pm2 delete claude-telegram-bot
 *
 * To auto-start on boot:
 *   pm2 startup
 *   pm2 save
 */

module.exports = {
  apps: [{
    name: "claude-telegram-bot",
    script: "bun",
    args: "run start",
    cwd: "/home/ubuntu/Projects/claude-telegram-bot",

    // Auto-restart configuration
    autorestart: true,
    max_restarts: 10,           // Max restarts within min_uptime window
    min_uptime: "10s",          // Min uptime to consider "started"
    restart_delay: 35000,       // Wait 35s between restarts (Telegram polling timeout is 30s)
    exp_backoff_restart_delay: 5000, // Exponential backoff starting at 5s

    // Environment
    env: {
      NODE_ENV: "production",
    },

    // Logging
    log_file: "/tmp/claude-telegram-bot.log",
    error_file: "/tmp/claude-telegram-bot.err",
    out_file: "/tmp/claude-telegram-bot.out",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",

    // Watch for changes (disabled in production)
    watch: false,
    ignore_watch: ["node_modules", ".git", "*.log", "*.md"],

    // Graceful shutdown
    kill_timeout: 5000,         // Wait 5s for graceful shutdown
    listen_timeout: 10000,      // Wait 10s for app to start

    // Instance mode (single instance for Telegram bot)
    instances: 1,
    exec_mode: "fork",
  }]
};
