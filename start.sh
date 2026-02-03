#!/bin/bash
# Start Claude Telegram Bot

cd /home/ubuntu/Projects/claude-telegram-bot
export PATH="$HOME/.bun/bin:$PATH"

# Load environment
set -a
source .env
set +a

# Start the bot
exec bun run start
