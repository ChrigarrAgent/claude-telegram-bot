/**
 * Test bot command registration
 */
import { Bot } from "grammy";
import { handleVerify, handleLink } from "./src/handlers";

const bot = new Bot("fake-token-for-testing");

// Register commands like in index.ts
bot.command("link", handleLink);
bot.command("verify", handleVerify);

console.log("✓ Commands registered");
console.log("Testing command matching...");

// Test if verify command would match
const testMessage = "/verify 123456";
console.log(`Message: "${testMessage}"`);
console.log(`Starts with /: ${testMessage.startsWith("/")}`);
console.log(`Command part: "${testMessage.split(" ")[0]}"`);

