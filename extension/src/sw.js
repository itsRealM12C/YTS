// Service worker: the only part that talks to api.giphy.com. GIPHY's REST API
// returns structured JSON directly, and hands the content script a short
// list of { id, title, preview, width, height }.

// Get a free key at https://developers.giphy.com (Create App -> API key),
// paste it below. Nothing works until this is set.
const GIPHY_API_KEY = 'RdAoDzgWqm7FzNF99zHR6YLzXjMBV7A4';

const GIPHY = 'https://api.giphy.com/v1';
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 50;

// url -> { time, value }
const cache = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(
    (gifs) => sendResponse({ ok: true, gifs }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true;
});

async function handle(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('Bad request.');
  if (msg.type === 'featured') return featured();
  if (msg.type === 'search' && typeof msg.query === 'string') return search(msg.query);
  if (msg.type === 'resolve' && typeof msg.input === 'string') return resolve(msg.input);
  throw new Error('Bad request.');
}

async function fetchJson(url) {
if (!GIPHY_API_KEY || GIPHY_API_KEY === 'YOUR_GIPHY_API_KEY') {
    throw new Error('No GIPHY API key set. Edit GIPHY_API_KEY in sw.js (free key at developers.giphy.com).');
  }
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.value;
  const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!res.ok) throw new Error(res.status === 404 ? 'GIPHY could not find that GIF.' : `GIPHY returned HTTP ${res.status}.`);
  const value = await res.json();
  if (value.meta && value.meta.status !== 200) throw new Error(value.meta.msg || 'GIPHY returned an error.');
  cache.set(url, { time: Date.now(), value });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return value;
}

function toGif(r) {
  if (!r || typeof r.id !== 'string' || !r.id || !r.images) return null;
  const f = r.images.fixed_width || r.images.downsized || r.images.original;
  if (!f || typeof f.url !== 'string') return null;
  return {
    id: r.id,
    title: String(r.title || 'GIF').slice(0, 200),
    preview: f.url,
    width: Number(f.width) || 220,
    height: Number(f.height) || 124,
  };
}

const toGifs = (results) => (results || []).map(toGif).filter(Boolean).slice(0, MAX_RESULTS);

async function featured() {
  const data = await fetchJson(`${GIPHY}/gifs/trending?api_key=${GIPHY_API_KEY}&limit=${MAX_RESULTS}&rating=pg-13`);
  return toGifs(data.data);
}

async function search(query) {
  const q = query.trim();
  if (!q) return featured();
  const data = await fetchJson(`${GIPHY}/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=${MAX_RESULTS}&rating=pg-13`);
  return toGifs(data.data);
}

// Accepts a giphy.com page link, a media.giphy.com/i.giphy.com file link, or
// a bare GIPHY ID, and returns the one GIF it points at.
async function resolve(input) {
  const text = input.trim();
  let id;
  if (/^[A-Za-z0-9]{10,24}$/.test(text)) {
    id = text;
  } else {
    let url;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch (e) { throw new Error('That is not a GIPHY link.'); }
    if (/(^|\.)giphy\.com$/.test(url.hostname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      const fromSlug = last.match(/-([A-Za-z0-9]{10,24})$/);
      const fromMedia = parts.find((p) => /^[A-Za-z0-9]{10,24}$/.test(p));
      id = (fromSlug && fromSlug[1]) || fromMedia;
    }
  }
  if (!id) throw new Error('That is not a GIPHY GIF link.');
  const data = await fetchJson(`${GIPHY}/gifs/${encodeURIComponent(id)}?api_key=${GIPHY_API_KEY}`);
  const gif = toGif(data.data);
  if (!gif) throw new Error('That link does not point at a GIF.');
  return [gif];
}
