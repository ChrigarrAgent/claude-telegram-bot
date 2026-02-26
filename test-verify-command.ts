/**
 * Test if handleVerify is properly exported and can be imported
 */
import { handleVerify } from "./src/handlers";

console.log("✓ handleVerify imported successfully");
console.log("Type:", typeof handleVerify);
console.log("Name:", handleVerify.name);

// Check if the function exists
if (typeof handleVerify === 'function') {
  console.log("✅ handleVerify is a function and ready to use");
} else {
  console.log("❌ handleVerify is NOT a function!");
}
