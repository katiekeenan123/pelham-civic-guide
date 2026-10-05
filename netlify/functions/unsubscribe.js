// Netlify serverless function: unsubscribe from the Pelham Civic Digest.
//
// Every digest email carries /api/unsubscribe?token=<subscribers.unsubscribe_token>
// (check_digest.py in the companion repo builds the link, and sets it as the
// List-Unsubscribe header).
//
//   GET   shows where the subscriber stands: a confirm button, "already
//         unsubscribed", or "invalid link". It changes nothing, because email
//         security scanners open links on their own.
//   POST  sets unsubscribed_at = now(). This is the confirm button, and also
//         RFC 8058 one-click unsubscribe (mail clients POST
//         "List-Unsubscribe=One-Click" to the same URL).
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_KEY (the anon key cannot read or
// update subscribers). check_digest.py --send skips rows where
// unsubscribed_at is set.

const {
  UUID_RE, htmlPage, message, button, postButton, readParams, serviceClient,
} = require('../lib/shared');

// check_digest.py puts this all-zero token in the draft preview it emails to
// the editor, so that link must not look like a broken one.
const PREVIEW_TOKEN = '00000000-0000-0000-0000-000000000000';

const HOME = button('/', 'Visit pelhamengagementproject.org →');
const page = {
  done: () => htmlPage(200, 'Unsubscribed',
    message("You've been unsubscribed from the Pelham Civic Digest. You won't receive any more emails from us.") + HOME),
  already: () => htmlPage(200, 'Already unsubscribed', message("You're already unsubscribed.") + HOME),
  invalid: () => htmlPage(404, 'Invalid link',
    message('This unsubscribe link is invalid or has already been used.') + HOME),
  preview: () => htmlPage(200, 'Preview link',
    message('This is the unsubscribe link from a draft preview. It does not unsubscribe anyone.') + HOME),
  confirm: (token) => htmlPage(200, 'Unsubscribe',
    message('Unsubscribe from the Pelham Civic Digest?')
    + postButton(`/api/unsubscribe?token=${encodeURIComponent(token)}`, 'Unsubscribe')
    + '<p style="font-size:13px;color:#4a5568;margin:0;">You will stop receiving the monthly digest straight away.</p>'),
  error: () => htmlPage(502, 'Something went wrong',
    message('Something went wrong — please try the link again in a moment.') + HOME),
  config: () => htmlPage(500, 'Something went wrong',
    message('Something went wrong — please try the link again later.') + HOME),
};

function createHandler(getClient) {
  return async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: { Allow: 'GET, POST' }, body: 'Method not allowed' };
    }
    const token = String(readParams(event).token || '').trim().toLowerCase();
    if (token === PREVIEW_TOKEN) return page.preview();
    if (!UUID_RE.test(token)) return page.invalid();

    const supabase = getClient();
    if (!supabase) {
      console.warn('[unsubscribe] missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
      return page.config();
    }

    try {
      const lookup = async () => {
        const { data, error } = await supabase.from('subscribers')
          .select('unsubscribed_at').eq('unsubscribe_token', token).maybeSingle();
        if (error) throw error;
        return data;
      };

      if (event.httpMethod === 'GET') {
        const row = await lookup();
        if (!row) return page.invalid();
        return row.unsubscribed_at ? page.already() : page.confirm(token);
      }

      // Only rows not yet unsubscribed are touched, so a repeat click keeps
      // the original date and reports "already".
      const { data, error } = await supabase.from('subscribers')
        .update({ unsubscribed_at: new Date().toISOString() })
        .eq('unsubscribe_token', token).is('unsubscribed_at', null)
        .select('id');
      if (error) throw error;
      if (data && data.length) return page.done();
      const row = await lookup();
      return row ? page.already() : page.invalid();
    } catch (err) {
      console.warn('[unsubscribe]', err && err.message ? err.message : String(err));
      return page.error();
    }
  };
}

exports.handler = createHandler(serviceClient);
exports.createHandler = createHandler;
