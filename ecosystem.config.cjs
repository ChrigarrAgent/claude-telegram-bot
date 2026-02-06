/**
 * PM2 Ecosystem Configuration for Claude Telegram Bot
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart claude-telegram-bot
 *   pm2 logs claude-telegram-bot
 *   pm2 stop claude-telegram-bot
 *   pm2 delete claude-telegram-bot
 *
 * To auto-start on boot:
 *   pm2 startup
 *   pm2 save
 *
 * IMPORTANT: 409 Conflict Prevention
 *   The bot uses a PID lock file (/tmp/claude-telegram-bot.pid) to prevent
 *   multiple instances. If the bot crashes, the lock file is cleaned up
 *   automatically on the next start.
 *
 *   If you see "Another instance is already running" errors:
 *   1. Check for stale processes: pgrep -af "bun.*claude"
 *   2. Kill them: pkill -9 -f "bun.*claude-telegram-bot"
 *   3. Remove lock: rm /tmp/claude-telegram-bot.pid
 *   4. Restart: pm2 restart claude-telegram-bot
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
    min_uptime: "15s",          // Min uptime to consider "started" (increased for lock acquisition)
    restart_delay: 40000,       // Wait 40s between restarts (> 30s Telegram timeout + lock cleanup)
    exp_backoff_restart_delay: 10000, // Exponential backoff starting at 10s

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

    // Graceful shutdown - give time for lock release and session save
    kill_timeout: 10000,        // Wait 10s for graceful shutdown
    listen_timeout: 15000,      // Wait 15s for app to start (includes lock acquisition)
    wait_ready: false,          // Don't wait for ready signal

    // Instance mode (single instance for Telegram bot - CRITICAL)
    instances: 1,
    exec_mode: "fork",

    // Stop old instance completely before starting new one
    // This helps prevent 409 conflicts during restarts
    treekill: true,
  }]
};
