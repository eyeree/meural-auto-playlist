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

// Candidates arrive newest feed feature first. Existing items fill remaining space,
// newest additions first. Artwork creation dates do not measure playlist age.
function planPlaylist(existing, candidates, direction, history = {}, limit = 100) {
  const unique = new Map();
  for (const item of candidates) if (matches(item, direction) && item.isPublic === true && !unique.has(String(item.id))) unique.set(String(item.id), item);
  const retained = existing.filter(item => matches(item, direction));
  retained.sort((a, b) => (Date.parse(history[b.id]?.addedAt) || 0) - (Date.parse(history[a.id]?.addedAt) || 0));
  for (const item of retained) if (!unique.has(String(item.id))) unique.set(String(item.id), item);
  const desired = [...unique.values()].slice(0, limit);
  const want = new Set(desired.map(x => String(x.id))), have = new Set(existing.map(x => String(x.id)));
  return { desired, add: desired.filter(x => !have.has(String(x.id))), remove: existing.filter(x => !want.has(String(x.id))) };
}

async function collectFeed(api, maxPages = 10, limit = 100, log = () => {}) {
  const fingerprints = new Set(), galleries = new Set(), seen = new Set();
  const candidates = [], sources = [], counts = { portrait: 0, landscape: 0 };
  for (let page = 1; page <= maxPages; page++) {
    const response = await api.feedPage(page);
    if (!Array.isArray(response.data) || typeof response.isLast !== 'boolean') throw new Error('Unexpected feed response.');
    const fingerprint = JSON.stringify(response.data.map(p => [p.postType, p.post?.id]));
    if (fingerprints.has(fingerprint)) throw new Error('Feed pagination repeated a page.');
    fingerprints.add(fingerprint);
    log(`Read feed page ${page}: ${response.data.length} entries.`);
    // The live feed is paginated newest-first. Process each page before fetching
    // older pages; there is no need to scan older content once both lists are full.
    const posts = [...response.data].sort((a,b) => (Date.parse(b.post?.featuredAt) || 0) - (Date.parse(a.post?.featuredAt) || 0));
    for (const post of posts) {
      const gallery = post.post;
      if (post.postType !== 'gallery' || gallery?.isPublic !== true || galleries.has(String(gallery.id))) continue;
      galleries.add(String(gallery.id));
      const items = await api.galleryItems(gallery.id);
      log(`Read public playlist "${gallery.name}": ${items.length} items.`);
      sources.push({ id: gallery.id, name: gallery.name, featuredAt: gallery.featuredAt, items: items.length });
      for (const item of items) {
        if (seen.has(String(item.id)) || item.isPublic !== true || item.type !== 'image') continue;
        seen.add(String(item.id)); candidates.push({ ...item, featuredAt: gallery.featuredAt, sourceGalleryId: gallery.id });
        for (const direction of Object.keys(counts)) if (matches(item, direction)) counts[direction]++;
      }
      if (counts.portrait >= limit && counts.landscape >= limit) return { candidates, sources, scannedPublicPlaylists: galleries.size };
    }
    if (response.isLast) return { candidates, sources, scannedPublicPlaylists: galleries.size };
  }
  log(`Feed scan limited to ${maxPages} pages; increase --feed-pages to scan further.`);
  return { candidates, sources, scannedPublicPlaylists: galleries.size };
}
module.exports = { orientation, matches, planPlaylist, collectFeed };
