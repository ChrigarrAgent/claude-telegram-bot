# TTS Usage Tracking

## Overview
Automatic tracking of Google Cloud Text-to-Speech API usage to stay within free tier limits and prevent unexpected charges.

## Features

### 📊 Automatic Tracking
- **Characters tracked:** Every TTS request counts characters sent to Google API
- **Monthly reset:** Usage resets automatically on the first of each month
- **Persistent storage:** `~/.claude/telegram-tts-usage.json`

### 🚨 Smart Limits
- **Warning threshold:** 85% - Logs warning to console
- **Auto-disable threshold:** 98% - Automatically disables TTS to prevent overage
- **Default limit:** 1,000,000 characters/month (Google Cloud free tier)

### 💬 User Commands

#### `/voice status`
Shows detailed usage statistics:
```
📊 TTS Usage Statistics

Month: 2026-02
Characters used: 234,567 / 1,000,000
Requests: 1,234
Usage: 23.5%
[████░░░░░░░░░░░░░░░░]

Remaining: 765,433 characters
Status: 🟢 Active

Auto-disables at 980,000 characters (98%)
```

#### `/voice override`
Manually re-enable TTS after auto-disable:
```
✅ TTS manually re-enabled.

⚠️ Warning: You've used 98.5% of your monthly limit.
Continuing may result in charges if you exceed the free tier.
```

#### Updated `/voice` help
Now includes:
- `/voice on` - Enable voice responses
- `/voice off` - Disable voice responses
- `/voice status` - Check TTS usage stats
- `/voice clear` - Reset to default (groups only)
- `/voice override` - Manually re-enable if disabled

## Technical Implementation

### Core Module: `src/tts-usage.ts`

**Key Functions:**
```typescript
trackTTSUsage(characters: number)     // Call after successful TTS
isTTSDisabledByUsage(): boolean      // Check before TTS
getTTSUsageStats(): object           // Get current stats
setTTSDisabled(disabled: boolean)    // Manual override
resetTTSUsage()                      // Reset (for testing)
```

### Integration Points

**1. `src/utils.ts` - synthesizeVoice()**
```typescript
// Check limits before calling API
if (isTTSDisabledByUsage()) {
  console.warn("[TTS] Disabled due to usage limits");
  return null;
}

// ... make TTS API call ...

// Track successful usage
trackTTSUsage(cleanedText.length);
```

**2. `src/handlers/commands.ts` - handleVoice()**
- Added `status` command
- Added `override` command
- Updated help text
- Added progress bar visualization

## Google Cloud Free Tier Limits

| Voice Type | Free Tier |
|------------|-----------|
| Standard (en-US-Standard-*) | 1M characters/month |
| WaveNet (en-US-Wavenet-*) | 1M characters/month |
| Neural2 (en-US-Neural2-*) | 1M characters/month (first 4M free for new users) |

**Note:** Default limit is set conservatively at 1M characters/month.

## Usage Scenarios

### Normal Usage
```
1. User enables voice mode: /voice on
2. Claude responds with TTS audio
3. Usage tracked automatically
4. User continues normally
```

### Approaching Limit
```
1. User at 85% usage
2. Console warning logged
3. User checks status: /voice status
4. User sees usage stats and remaining quota
```

### Limit Reached
```
1. User hits 98% usage (980,000 chars)
2. TTS auto-disables
3. Voice mode still "on" but no audio sent
4. Console shows: "[TTS] Disabled due to usage limits"
5. User can check status: /voice status
6. User can override: /voice override (at their own risk)
```

### Monthly Reset
```
1. New month starts (e.g., Feb 1 → Mar 1)
2. Usage auto-resets to 0
3. TTS auto-enables
4. User can continue using voice mode
```

## Configuration

### Change Monthly Limit
```typescript
import { setMonthlyLimit } from "./tts-usage";

// For paid tier with higher limits
setMonthlyLimit(10_000_000); // 10M characters
```

### Manual Reset (Testing)
```typescript
import { resetTTSUsage } from "./tts-usage";
resetTTSUsage();
```

## File Structure

```
~/.claude/
  telegram-tts-usage.json    # Usage tracking data
```

**Example file:**
```json
{
  "month": "2026-02",
  "charactersUsed": 234567,
  "requestCount": 1234,
  "lastUpdated": "2026-02-07T19:45:30.123Z",
  "monthlyLimit": 1000000,
  "disabled": false
}
```

## Benefits

✅ **Cost Control:** Never exceed free tier unintentionally
✅ **Transparency:** Users can check usage anytime
✅ **Automatic:** No manual intervention needed
✅ **Safe:** Auto-disables before hitting limit
✅ **Flexible:** Manual override available if needed
✅ **Monthly Reset:** Automatically resets each month

## Testing

Run the test script:
```bash
bun /tmp/test-tts-usage.ts
```

Expected output:
- Shows initial state (0% usage)
- Simulates 85% usage → warning logged
- Simulates 98% usage → auto-disabled
- Resets and cleans up

## Future Enhancements

Potential improvements:
- [ ] Email notification at 90% usage
- [ ] Weekly/daily usage reports
- [ ] Per-user usage tracking (multi-user support)
- [ ] Configurable thresholds via environment variables
- [ ] Usage history chart (last 6 months)
- [ ] Integration with Google Cloud billing API for real-time data
