// Netlify serverless function: approve a drafted Pelham Civic Digest.
//
// check_digest.py --draft (companion repo) stores a digest at status 'draft'
// and emails the editor an "Approve and send" link:
//     /api/digest-approve?token=<digests.id>&secret=<DIGEST_APPROVAL_SECRET>
//
//   GET                shows the digest's subject, status and send date, with
//                      an Approve button. It changes nothing: email security
//                      scanners open links on their own, and an approval sends
//                      the digest to every subscriber.
//   GET  &view=preview the stored digest itself, as subscribers would see it.
//   POST               the Approve button: status 'draft' -> 'approved'.
//
// A wrong or missing secret is a 403 on every path. Needs SUPABASE_URL,
// SUPABASE_SERVICE_KEY and DIGEST_APPROVAL_SECRET (the same value the
// pipeline uses to build the link).
//
// Approval is the consent; sending is check_digest.py --send-approved, which
// runs on the Thursday after the month's last Monday and sends only a digest
// approved by then and drafted on or after that Monday. sendDateFor() mirrors
// that rule, so the page can say when the digest will go out, or that it will
// not go out on its own.

const {
  esc, UUID_RE, htmlPage, message, button, secondary, postButton,
  readParams, secretMatches, serviceClient,
} = require('../lib/shared');

const SEND_HOUR_UTC = 12;
const UNSUBSCRIBE_PLACEHOLDER = '{{unsubscribe_url}}';
const DAY = 86400000;

function lastMondayOfMonth(year, month) { // month 0-11, UTC
  const last = new Date(Date.UTC(year, month + 1, 0));
  return new Date(last.getTime() - ((last.getUTCDay() + 6) % 7) * DAY); // Monday = 1
}

// When check_digest.py --send-approved would send a digest drafted at
// createdAt, or null if it never would. Mirrors draft_monday_for /
// send_day_for: the latest last-Monday on or before the draft date, plus three
// days, at the job's 12:00 UTC run; the draft must predate that run.
function sendDateFor(createdAt) {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const y = created.getUTCFullYear();
  const m = created.getUTCMonth();
  const day = Date.UTC(y, m, created.getUTCDate());
  const monday = [lastMondayOfMonth(y, m), lastMondayOfMonth(y, m - 1)]
    .map((d) => d.getTime()).filter((t) => t <= day).sort((a, b) => b - a)[0];
  if (monday === undefined) return null;
  const sendAt = new Date(monday + 3 * DAY + SEND_HOUR_UTC * 3600000);
  return created < sendAt ? sendAt : null;
}

const fmtDay = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

// What will happen to an approved digest, in words.
function scheduleLine(digest, now, approved) {
  const sendAt = sendDateFor(digest.created_at);
  if (sendAt && now < sendAt) {
    return approved
      ? `It will be sent to subscribers on ${fmtDay(sendAt)} at 12:00 UTC.`
      : `If approved, it will be sent to subscribers on ${fmtDay(sendAt)} at 12:00 UTC.`;
  }
  const why = sendAt
    ? `Its scheduled send (${fmtDay(sendAt)} at 12:00 UTC) has passed`
    : 'It was not drafted for a scheduled send';
  return `${why}, so it will not go out automatically. To send it by hand: `
    + `<code>python check_digest.py --send ${esc(digest.id)}</code>`;
}

function createHandler(getClient, { now = () => new Date() } = {}) {
  return async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: { Allow: 'GET, POST' }, body: 'Method not allowed' };
    }
    const params = readParams(event);
    const expected = process.env.DIGEST_APPROVAL_SECRET;
    if (!expected) {
      console.warn('[digest-approve] DIGEST_APPROVAL_SECRET is not set');
      return htmlPage(500, 'Not configured', message('Digest approval is not configured on this site.'));
    }
    if (!secretMatches(params.secret, expected)) {
      return htmlPage(403, 'Not authorized', message('This approval link is not valid.'));
    }

    const id = String(params.token || '').trim().toLowerCase();
    const notFound = () => htmlPage(404, 'Digest not found', message('No digest matches this link.') + button('/', 'Return to site →'));
    if (!UUID_RE.test(id)) return notFound();

    const supabase = getClient();
    if (!supabase) {
      console.warn('[digest-approve] missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
      return htmlPage(500, 'Not configured', message('Digest approval is not configured on this site.'));
    }

    const self = `/api/digest-approve?token=${encodeURIComponent(id)}&secret=${encodeURIComponent(params.secret)}`;
    const links = secondary(`${self}&view=preview`, 'View digest preview →') + secondary('/', 'Return to site →');
    const already = (digest) => (digest.status === 'sent'
      ? htmlPage(200, 'Already sent', message('This digest has already been sent.') + links)
      : htmlPage(200, 'Already approved', message('This digest has already been approved.')
        + `<p style="margin:0 0 24px;">${scheduleLine(digest, now(), true)}</p>` + links));

    try {
      const load = async () => {
        const { data, error } = await supabase.from('digests')
          .select('id, subject, status, created_at, html_body').eq('id', id).maybeSingle();
        if (error) throw error;
        return data;
      };

      if (event.httpMethod === 'GET') {
        const digest = await load();
        if (!digest) return notFound();
        if (params.view === 'preview') {
          const banner = '<div style="background:#1a2744;color:#fff;padding:10px 16px;font:14px system-ui,sans-serif;">'
            + `Preview of ${esc(digest.subject)} — status: ${esc(digest.status)}. Not sent from this page.</div>`;
          const page = htmlPage(200, digest.subject, '');
          page.body = banner + String(digest.html_body).split(UNSUBSCRIBE_PLACEHOLDER).join('#');
          return page;
        }
        if (digest.status !== 'draft') return already(digest);
        return htmlPage(200, 'Approve digest',
          `<p style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#4a5568;margin:0 0 8px;">Draft digest</p>`
          + `<h1 style="font-family:Georgia,serif;font-size:26px;margin:0 0 16px;">${esc(digest.subject)}</h1>`
          + `<p style="margin:0 0 24px;">${scheduleLine(digest, now(), false)}</p>`
          + postButton(self, 'Approve digest')
          + links);
      }

      // POST: only a draft moves to approved, so a second click, or a click
      // after sending, cannot change a status the pipeline has moved on from.
      const { data, error } = await supabase.from('digests')
        .update({ status: 'approved' })
        .eq('id', id).eq('status', 'draft')
        .select('id, subject, status, created_at');
      if (error) throw error;
      if (data && data.length) {
        const sendAt = sendDateFor(data[0].created_at);
        const lead = sendAt && now() < sendAt
          ? `Digest approved! It will be sent to subscribers on ${fmtDay(sendAt)} at 12:00 UTC.`
          : `Digest approved. ${scheduleLine(data[0], now(), true)}`;
        return htmlPage(200, 'Digest approved', message(lead) + links);
      }
      const digest = await load();
      return digest ? already(digest) : notFound();
    } catch (err) {
      console.warn('[digest-approve]', err && err.message ? err.message : String(err));
      return htmlPage(502, 'Something went wrong', message('Something went wrong — please try the link again in a moment.'));
    }
  };
}

exports.handler = createHandler(serviceClient);
exports.createHandler = createHandler;
exports.sendDateFor = sendDateFor;
