// Runs in the page's own JavaScript world. Wraps window.fetch so that a comment
// request whose text is an armed marker is rewritten into a GIF comment.
//
// The content script never sends anything itself: it appends a marker such as
// [[gif:<giphyId>:<nonce>]] to the text in YouTube's comment box and lets the
// page submit it. That way the page supplies the auth headers, context and
// attestation. The hook strips the marker and adds the GIF in its place.
(() => {
  // Every endpoint a ytd-commentbox can submit to (comments, replies, edits,
  // channel posts). Only the two create endpoints are ever rewritten; a marker
  // heading anywhere else is blocked so it cannot be published as text.
  const WATCHED_URL = /\/youtubei\/v1\/(comment|backstage)\//;
  const CREATE_URL = /\/youtubei\/v1\/comment\/create_comment(_reply)?(\?|$)/;
  const MARKER = /\[\[gif:([A-Za-z0-9]{1,32}):([a-z0-9]{8,32})\]\]/;
  const ARM_TTL_MS = 3 * 60 * 1000;
  // UNVERIFIED: old code sent body.tenorId, and the README said outright
  // "YouTube's GIF comments take Tenor GIFs" - this field may be Tenor-
  // specific server-side, not a generic external-id slot. A GIPHY id sent
  // through it may get silently dropped. No confirmed alternate field name
  // exists - test a real post before relying on this.
  const GIF_ID_FIELD = 'tenorId';

  // nonce -> { id, expires }
  const armed = new Map();

  const toContent = (msg) => window.postMessage({ gcfy: 'to-content', ...msg }, location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.gcfy !== 'to-main') return;
    if (msg.type === 'arm' && /^[A-Za-z0-9]{1,32}$/.test(msg.id) && /^[a-z0-9]{8,32}$/.test(msg.nonce)) {
      armed.set(msg.nonce, { id: msg.id, expires: Date.now() + ARM_TTL_MS });
      toContent({ type: 'armed', nonce: msg.nonce });
    } else if (msg.type === 'disarm') {
      armed.delete(msg.nonce);
    }
  });

  async function readBody(input, init) {
    const isRequest = input instanceof Request;
    const headers = new Headers(isRequest ? input.headers : (init && init.headers) || {});
    let buf;
    if (isRequest) buf = await input.clone().arrayBuffer();
    else if (init && init.body != null) buf = await new Response(init.body).arrayBuffer();
    else return null;
    // YouTube gzips request bodies between 500 bytes and 500 kB.
    const text = headers.get('content-encoding') === 'gzip'
      ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(buf);
    return { headers, text };
  }

  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    } catch (e) { /* fall through to the original fetch */ }
    if (!WATCHED_URL.test(url)) return originalFetch.apply(this, arguments);
    return handleWatched.call(this, url, input, init, arguments);
  };

  async function handleWatched(url, input, init, originalArgs) {
    let parsed = null;
    try {
      parsed = await readBody(input, init);
    } catch (e) { /* a body we cannot read: leave the request alone */ }

    const match = parsed && parsed.text.match(MARKER);
    if (!match) return originalFetch.apply(this, originalArgs);

    // From here on a marker is present, so the original request must never be
    // sent: it would publish the marker as visible text.
    const [whole, id, nonce] = match;
    const entry = armed.get(nonce);
    armed.delete(nonce);

    let body = null;
    try { body = JSON.parse(parsed.text); } catch (e) { /* handled below */ }
    // The marker sits at the very end of the comment; anything before it is
    // the user's own text and is posted alongside the GIF.
    const full = body && typeof body.commentText === 'string' ? body.commentText.trim() : '';
    const ownText = full.endsWith(whole) ? full.slice(0, -whole.length).trim() : null;
    const valid = body && CREATE_URL.test(url)
      && ownText !== null && !MARKER.test(ownText)
      && entry && entry.id === id && entry.expires >= Date.now();
    if (!valid) {
      toContent({ type: 'result', nonce, ok: false, error: 'This box cannot take a GIF, or the request expired. Nothing was posted.' });
      throw new TypeError('GIF comment marker blocked');
    }

    toContent({ type: 'seen', nonce });
    let response;
    try {
      if (ownText) body.commentText = ownText;
      else delete body.commentText;
      body[GIF_ID_FIELD] = id;
      const headers = parsed.headers;
      headers.delete('content-encoding');
      const payload = JSON.stringify(body);
      response = input instanceof Request
        ? await originalFetch.call(this, new Request(input, { body: payload, headers }))
        : await originalFetch.call(this, input, { ...init, body: payload, headers });
    } catch (e) {
      toContent({ type: 'result', nonce, ok: false, error: 'The request could not be sent. Nothing was posted.' });
      throw e;
    }

    try {
      const json = await response.clone().json();
      const ok = response.ok && !!json.actionResult && json.actionResult.status === 'STATUS_SUCCEEDED';
      const feedback = json.actionResult && json.actionResult.feedbackText && json.actionResult.feedbackText.runs
        ? json.actionResult.feedbackText.runs.map((r) => r.text).join('')
        : '';
      const error = ok ? null : (json.error && json.error.message) || feedback || `YouTube returned HTTP ${response.status}.`;
      toContent({ type: 'result', nonce, ok, error });
    } catch (e) {
      toContent({ type: 'result', nonce, ok: response.ok, error: response.ok ? null : `YouTube returned HTTP ${response.status}.` });
    }
    return response;
  }
})();
