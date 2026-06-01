'use strict';
require('dotenv').config();
const express = require('express');
const { spawnSync } = require('child_process');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Time range resolver ────────────────────────────────────────────────────────
function resolveTimeRange(query) {
  const q = query.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  if (q.includes('next week')) {
    return { start: addDays(today, 7), end: addDays(today, 14), label: 'Events next week' };
  }
  if (q.includes('this week') || q.includes(' week')) {
    return { start: today, end: addDays(today, 7), label: 'Events this week' };
  }
  if (q.includes('this month') || q.includes(' month') || q.includes('next 30')) {
    return { start: today, end: addDays(today, 30), label: 'Events this month' };
  }
  if (q.includes('tomorrow')) {
    return { start: addDays(today, 1), end: addDays(today, 1), label: "Tomorrow's events" };
  }
  return { start: today, end: today, label: "Today's events" };
}

// AppleScript accepts: "Monday, June 1, 2026 at 12:00:00 AM"
function toAppleScriptDate(d) {
  return d.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

// ── Calendar events via AppleScript ───────────────────────────────────────────
function getCalendarEvents(start, end) {
  const endInclusive = new Date(end);
  endInclusive.setDate(endInclusive.getDate() + 1);

  const script = `
tell application "Calendar"
  set output to ""
  set startDate to date "${toAppleScriptDate(start)}"
  set endDate to date "${toAppleScriptDate(endInclusive)}"
  repeat with aCal in calendars
    set theEvents to (every event of aCal whose start date >= startDate and start date < endDate)
    repeat with ev in theEvents
      set output to output & (summary of ev) & "|" & ((start date of ev) as string) & linefeed
    end repeat
  end repeat
  return output
end tell`;

  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) {
    console.warn('Calendar AppleScript failed:', result.stderr || result.error?.message);
    return null;
  }
  return result.stdout.trim();
}

// ── Reminders via AppleScript ─────────────────────────────────────────────────
function getReminders() {
  const script = `
tell application "Reminders"
  set output to ""
  set cnt to 0
  repeat with aList in lists
    repeat with r in (every reminder of aList whose completed is false)
      if cnt < 50 then
        set rDue to ""
        try
          set rDue to (due date of r) as string
        end try
        set output to output & (name of r) & "|" & rDue & linefeed
        set cnt to cnt + 1
      end if
    end repeat
  end repeat
  return output
end tell`;

  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) {
    console.warn('Reminders AppleScript failed:', result.stderr || result.error?.message);
    return null;
  }
  return result.stdout.trim();
}

// ── Format raw AppleScript output into system prompt blocks ───────────────────
function buildCalendarBlock(raw, label) {
  if (raw === null) return '(Calendar data unavailable)';
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) return `${label}: none`;
  const items = lines.map(l => {
    const [summary, date] = l.split('|');
    return `• ${summary.trim()}${date?.trim() ? ' — ' + date.trim() : ''}`;
  });
  return `${label}:\n${items.join('\n')}`;
}

function buildRemindersBlock(raw) {
  if (raw === null) return '(Reminders data unavailable)';
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) return 'Active reminders: none';
  const items = lines.map(l => {
    const [name, due] = l.split('|');
    return `• ${name.trim()}${due?.trim() ? ' (due ' + due.trim() + ')' : ''}`;
  });
  return `Active reminders:\n${items.join('\n')}`;
}

// ── POST /ask ─────────────────────────────────────────────────────────────────
app.post('/ask', async (req, res) => {
  const { query, userContext, timezone, history = [] } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'query required' });

  const { start, end, label } = resolveTimeRange(query);
  const calRaw = getCalendarEvents(start, end);
  const remRaw = getReminders();

  const tz = timezone || 'UTC';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz,
  });

  const system = [
    userContext?.trim() ? `About the user:\n${userContext.trim()}` : null,
    `Today is ${today}.`,
    buildCalendarBlock(calRaw, label),
    buildRemindersBlock(remRaw),
    'You are a concise personal assistant. Responses appear on small glasses — keep answers to 1-3 sentences unless more detail is clearly needed.',
  ].filter(Boolean).join('\n\n');

  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: system },
          ...history,
          { role: 'user', content: query.trim() },
        ],
      }),
    });

    if (!ollamaRes.ok) {
      const txt = await ollamaRes.text();
      throw new Error(`Ollama ${ollamaRes.status}: ${txt}`);
    }

    const data = await ollamaRes.json();
    res.json({ response: data.message.content });
  } catch (err) {
    console.error('Ollama error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function checkOllama() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (r.ok) console.log(`Ollama reachable at ${OLLAMA_URL} (model: ${OLLAMA_MODEL})`);
    else console.warn(`Ollama returned ${r.status} — is it running?`);
  } catch {
    console.warn(`Ollama not reachable at ${OLLAMA_URL} — start it with: ollama serve`);
  }
}

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`Iris server listening on http://127.0.0.1:${PORT}`);
  await checkOllama();
});
