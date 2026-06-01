const Anthropic = require('@anthropic-ai/sdk');

// ── iCloud CalDAV client ───────────────────────────────────────────────────────

const CALDAV = 'https://caldav.icloud.com';

function basicAuth() {
  return 'Basic ' + Buffer.from(
    `${process.env.ICLOUD_USERNAME}:${process.env.ICLOUD_APP_PASSWORD}`
  ).toString('base64');
}

async function caldav(url, method, body, extra = {}) {
  const fullUrl = url.startsWith('http') ? url : CALDAV + url;
  const res = await fetch(fullUrl, {
    method,
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/xml; charset=utf-8', ...extra },
    body,
    redirect: 'follow',
  });
  return res.text();
}

// Walk the CalDAV discovery chain: root → principal → calendar-home → calendars
async function discoverCalendars() {
  // Step 1: find current-user-principal
  const principalXml = await caldav('/.well-known/caldav', 'PROPFIND',
    `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    { Depth: '0' }
  );
  const principalHref = firstHref(principalXml, /principal/i);
  if (!principalHref) throw new Error('Cannot find iCloud principal URL');

  // Step 2: find calendar-home-set
  const homeXml = await caldav(principalHref, 'PROPFIND',
    `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
    { Depth: '0' }
  );
  const homeHref = firstHref(homeXml, /calendars/i);
  if (!homeHref) throw new Error('Cannot find iCloud calendar home');

  // Step 3: list calendars
  const listXml = await caldav(homeHref, 'PROPFIND',
    `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`,
    { Depth: '1' }
  );

  const urls = [];
  for (const m of listXml.matchAll(/<[^:>]+:response[^>]*>([\s\S]*?)<\/[^:>]+:response>/g)) {
    const block = m[1];
    if (!block.match(/calendar/i) || block.match(/principal/i)) continue;
    const hm = block.match(/<[^:>]+:href[^>]*>([^<]+)<\/[^:>]+:href>/);
    if (hm && hm[1] !== homeHref) {
      urls.push(hm[1].startsWith('http') ? hm[1] : CALDAV + hm[1]);
    }
  }
  return urls;
}

function firstHref(xml, pattern) {
  for (const m of xml.matchAll(/<[^:>]+:href[^>]*>([^<]+)<\/[^:>]+:href>/g)) {
    if (!pattern || pattern.test(m[1])) {
      return m[1].startsWith('http') ? m[1] : CALDAV + m[1];
    }
  }
  return null;
}

// Fetch VEVENT objects with a time-range filter
async function fetchEvents(calUrl, from, to) {
  return caldav(calUrl, 'REPORT',
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:prop><d:getetag/><c:calendar-data/></d:prop>
      <c:filter>
        <c:comp-filter name="VCALENDAR">
          <c:comp-filter name="VEVENT">
            <c:time-range start="${from}" end="${to}"/>
          </c:comp-filter>
        </c:comp-filter>
      </c:filter>
    </c:calendar-query>`,
    { Depth: '1' }
  ).catch(() => '');
}

// Fetch incomplete VTODO (Reminders) objects
async function fetchTodos(calUrl) {
  return caldav(calUrl, 'REPORT',
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:prop><d:getetag/><c:calendar-data/></d:prop>
      <c:filter>
        <c:comp-filter name="VCALENDAR">
          <c:comp-filter name="VTODO">
            <c:prop-filter name="COMPLETED"><c:is-not-defined/></c:prop-filter>
          </c:comp-filter>
        </c:comp-filter>
      </c:filter>
    </c:calendar-query>`,
    { Depth: '1' }
  ).catch(() => '');
}

// Parse VEVENT and VTODO blocks out of a CalDAV REPORT response
function parseICalendar(xml) {
  const events = [], reminders = [];

  // Extract just the calendar-data content from the REPORT response
  const calData = [...xml.matchAll(/<[^:>]+:calendar-data[^>]*>([\s\S]*?)<\/[^:>]+:calendar-data>/g)]
    .map(m => m[1]).join('\n');

  const prop = (block, field) => {
    const m = block.match(new RegExp(`^${field}(?:;[^:]*)?:(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };

  for (const m of calData.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)) {
    const summary = prop(m[1], 'SUMMARY');
    if (summary) events.push({ summary, start: prop(m[1], 'DTSTART'), end: prop(m[1], 'DTEND') });
  }

  for (const m of calData.matchAll(/BEGIN:VTODO([\s\S]*?)END:VTODO/g)) {
    if (prop(m[1], 'STATUS') === 'COMPLETED') continue;
    const summary = prop(m[1], 'SUMMARY');
    if (summary) reminders.push({ summary, due: prop(m[1], 'DUE') });
  }

  return { events, reminders };
}

// Format an iCal date string (20241201T120000Z or 20241201) to readable text
function fmtDate(s) {
  if (!s) return '';
  const d = s.replace(/[^0-9]/g, '');
  const mo = d.slice(4, 6), day = d.slice(6, 8), h = d.slice(8, 10), min = d.slice(10, 12);
  return h ? `${mo}/${day} at ${h}:${min}` : `${mo}/${day}`;
}

async function fetchICloudData() {
  const calendars = await discoverCalendars();

  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const toIcal = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const results = await Promise.all(
    calendars.map(async url => {
      const [evXml, todoXml] = await Promise.all([
        fetchEvents(url, toIcal(now), toIcal(weekOut)),
        fetchTodos(url),
      ]);
      return parseICalendar(evXml + todoXml);
    })
  );

  return {
    events:    results.flatMap(r => r.events),
    reminders: results.flatMap(r => r.reminders),
  };
}

function buildCalendarBlock(events, reminders) {
  const lines = [];
  if (events.length) {
    lines.push('Upcoming events (next 7 days):');
    events.forEach(e => lines.push(`• ${e.summary}${e.start ? ' — ' + fmtDate(e.start) : ''}`));
  }
  if (reminders.length) {
    if (lines.length) lines.push('');
    lines.push('Active reminders:');
    reminders.forEach(r => lines.push(`• ${r.summary}${r.due ? ' (due ' + fmtDate(r.due) + ')' : ''}`));
  }
  return lines.length ? lines.join('\n') : 'No upcoming events or active reminders.';
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, userContext, timezone } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'query required' });

  // Fetch calendar data if iCloud is configured
  let calendarBlock = '';
  if (process.env.ICLOUD_USERNAME && process.env.ICLOUD_APP_PASSWORD) {
    try {
      const { events, reminders } = await fetchICloudData();
      calendarBlock = '\n\n' + buildCalendarBlock(events, reminders);
    } catch (err) {
      console.error('iCloud CalDAV error:', err.message);
      calendarBlock = '\n\n(Calendar data unavailable)';
    }
  }

  const tz = timezone || 'UTC';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz,
  });

  const system = [
    userContext?.trim() ? `About the user:\n${userContext.trim()}` : null,
    `Today is ${today}.${calendarBlock}`,
    'You are a concise personal assistant. Responses appear on small glasses — keep answers to 1-3 sentences unless more detail is clearly needed.',
  ].filter(Boolean).join('\n\n');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: query.trim() }],
  });

  res.json({ response: message.content[0].text });
};
