function orientation(value) {
  return ({ horizontal: 'landscape', landscape: 'landscape', vertical: 'portrait', portrait: 'portrait' })[value] || null;
}
function matches(item, direction) {
  if (item.type !== 'image') return false;
  const explicit = orientation(item.orientation);
  if (explicit) return explicit === direction;
  const width = Number(item.originalWidth), height = Number(item.originalHeight);
  return width > 0 && height > 0 && width !== height && (width > height ? 'landscape' : 'portrait') === direction;
}

function availableWithoutPurchase(item, membershipActive = false) {
  const zero = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number(value) === 0;
  return item.isPublic === true && item.type === 'image' &&
    (item.isSampler === true || zero(item.nonsubscriberPrice) || (membershipActive && zero(item.subscriberPrice)));
}

function planDesired(existing, desired) {
  const want = new Set(desired.map(x => String(x.id))), have = new Set(existing.map(x => String(x.id)));
  return { desired, add: desired.filter(x => !have.has(String(x.id))), remove: existing.filter(x => !want.has(String(x.id))) };
}

// Unseen images first; ties keep newest feed order. Reuse least recently shown
// images only when there are not enough unseen ones to fill the playlist.
function planPlaylist(existing, candidates, direction, history = {}, limit = 100) {
  const unique = new Map();
  for (const item of candidates) if (matches(item, direction) && item.isPublic === true && !unique.has(String(item.id))) unique.set(String(item.id), item);
  const retained = existing.filter(item => matches(item, direction));
  for (const item of retained) if (!unique.has(String(item.id))) unique.set(String(item.id), item);
  const current = new Set(existing.map(item => String(item.id)));
  const shown = item => Date.parse(history[item.id]?.lastShownAt || history[item.id]?.addedAt) || (current.has(String(item.id)) ? Number.MAX_SAFE_INTEGER : 0);
  const desired = [...unique.values()].sort((a, b) => shown(a) - shown(b)).slice(0, limit);
  return planDesired(existing, desired);
}

async function collectFeed(api, maxPages = 100, log = () => {}, { eligible = availableWithoutPurchase } = {}) {
  const fingerprints = new Set(), galleries = new Map(), seen = new Set();
  const candidates = [], sources = [];
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const response = await api.feedPage(page);
    if (!Array.isArray(response.data) || typeof response.isLast !== 'boolean') throw new Error('Unexpected feed response.');
    const fingerprint = JSON.stringify(response.data.map(p => [p.postType, p.post?.id]));
    if (fingerprints.has(fingerprint)) throw new Error('Feed pagination repeated a page.');
    fingerprints.add(fingerprint);
    log(`Read feed page ${page}: ${response.data.length} entries.`);
    for (const post of response.data) {
      const gallery = post.post;
      if (post.postType !== 'gallery' || gallery?.isPublic !== true || galleries.has(String(gallery.id))) continue;
      galleries.set(String(gallery.id), gallery);
    }
    if (response.isLast) { complete = true; break; }
  }
  if (!complete) log(`Feed scan limited to ${maxPages} pages; increase --feed-pages to scan further.`);
  const ordered = [...galleries.values()].sort((a,b) => (Date.parse(b.featuredAt) || 0) - (Date.parse(a.featuredAt) || 0));
  // Keep request concurrency bounded and preserve feed order regardless of
  // response timing. Wait for outstanding reads before propagating an error.
  const results = new Array(ordered.length);
  let next = 0, failed = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, ordered.length) }, async () => {
    while (next < ordered.length && !failed) {
      const index = next++, gallery = ordered[index];
      try {
        results[index] = await api.galleryItems(gallery.id);
        log(`Read public playlist "${gallery.name}": ${results[index].length} items.`);
      } catch (error) { failed = true; throw error; }
    }
  }));
  const error = workers.find(result => result.status === 'rejected');
  if (error) throw error.reason;
  let excluded = 0;
  for (let index = 0; index < ordered.length; index++) {
    const gallery = ordered[index], items = results[index];
    sources.push({ id: gallery.id, name: gallery.name, featuredAt: gallery.featuredAt, items: items.length });
    for (const item of items) {
      if (seen.has(String(item.id))) continue;
      if (!eligible(item)) { excluded++; continue; }
      seen.add(String(item.id)); candidates.push({ ...item, featuredAt: gallery.featuredAt, sourceGalleryId: gallery.id });
    }
  }
  log(`Rotation pool: ${candidates.filter(x => matches(x, 'portrait')).length} portrait, ${candidates.filter(x => matches(x, 'landscape')).length} landscape; ${excluded} entries excluded by type, visibility, or pricing.`);
  return { candidates, sources, scannedPublicPlaylists: galleries.size, complete };
}
module.exports = { orientation, matches, availableWithoutPurchase, planDesired, planPlaylist, collectFeed };
