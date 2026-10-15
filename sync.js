const { readJSON, writeJSON } = require('./store');
const { orientation, matches: imageMatches, planPlaylist, collectFeed } = require('./planner');

function validateConfig(config) {
  if (!Number.isInteger(config.maxImages) || config.maxImages < 1 || config.maxImages > 100) throw new Error('maxImages must be between 1 and 100.');
  if (!Number.isInteger(config.feedPages) || config.feedPages < 1 || config.feedPages > 100) throw new Error('feedPages must be between 1 and 100.');
  if (!Array.isArray(config.devices) || !config.devices.length) throw new Error('Configure at least one device.');
  const ids = new Set(), names = new Set();
  for (const target of config.devices) {
    if (!Number.isSafeInteger(target.id) || !orientation(target.orientation) || !target.playlistName?.trim()) throw new Error('Each device needs an integer id, portrait/landscape orientation, and playlistName.');
    if (ids.has(target.id) || names.has(target.playlistName)) throw new Error('Device IDs and playlist names must be unique.');
    ids.add(target.id); names.add(target.playlistName);
  }
}

async function prepare(api, config, state, log) {
  validateConfig(config);
  const user = await api.getData('/user');
  if (!user?.id) throw new Error('Missing account ID.');
  if (state.userId && String(state.userId) !== String(user.id)) throw new Error('Saved state belongs to another Meural account.');
  const devices = await api.devices(), owned = await api.galleries();
  const targets = [];
  for (const target of config.devices) {
    const device = devices.find(d => String(d.id) === String(target.id));
    if (!device) throw new Error(`Device ${target.id} is not on this account.`);
    const direction = orientation(target.orientation);
    if (orientation(device.orientation) !== direction) throw new Error(`${device.alias}: orientation changed; update the config before syncing.`);
    const saved = state.devices?.[target.id] || {};
    const matches = saved.galleryId ? owned.filter(g => String(g.id) === String(saved.galleryId)) : owned.filter(g => g.name === target.playlistName);
    if (matches.length > 1) throw new Error(`Multiple owned playlists named ${target.playlistName}; choose a unique name.`);
    if (saved.galleryId && matches.length !== 1) throw new Error(`Managed playlist ${saved.galleryId} is missing or no longer owned. Check saved state.`);
    const gallery = matches[0];
    const existing = gallery ? await api.galleryItems(gallery.id) : [];
    targets.push({ target, device, saved, gallery, existing, direction });
  }
  if (new Set(targets.filter(t=>t.gallery).map(t=>String(t.gallery.id))).size !== targets.filter(t=>t.gallery).length) throw new Error('Devices must use different managed playlists.');
  const feed = await collectFeed(api, config.feedPages, config.maxImages, log);
  for (const t of targets) {
    t.plan = planPlaylist(t.existing, feed.candidates, t.direction, t.saved.items, config.maxImages);
    if (!feed.candidates.some(x => x.isPublic && imageMatches(x, t.direction))) throw new Error(`No public ${t.direction} feed images found; refusing to clear a playlist.`);
    log(`${t.device.alias} (${t.direction}): ${t.gallery ? `playlist ${t.gallery.id}` : `create "${t.target.playlistName}"`}; add ${t.plan.add.length}, remove ${t.plan.remove.length}, final ${t.plan.desired.length}/${config.maxImages}.`);
  }
  return { targets, feed, userId: user.id, limit: config.maxImages };
}

async function cleanDevice(api, device, keepGalleryId, log, keepItemIds = []) {
  // Delete associations on THIS device only. Never call DELETE /items/:id or
  // DELETE /galleries/:id, which would delete account content.
  const latest = await api.getData(`/devices/${device.id}`);
  for (const id of latest.galleryIds || []) {
    if (String(id) === String(keepGalleryId)) continue;
    await api.request('DELETE', `/devices/${device.id}/galleries/${id}`);
    log(`${device.alias}: detached old device playlist ${id}.`);
  }
  const keep = new Set(keepItemIds.map(String));
  for (const id of latest.itemIds || []) if (!keep.has(String(id))) await api.request('DELETE', `/devices/${device.id}/items/${id}`);
}

async function applyPrepared(api, prepared, state, stateFile, { cleanupDevice = false, log = console.log } = {}) {
  state.version = 1; state.userId = prepared.userId; state.devices ||= {};
  for (const t of prepared.targets) {
    let gallery = t.gallery;
    if (!gallery) {
      gallery = await api.galleryCreate(t.target.playlistName, 'Managed by meural-playlist-builder; latest public feed images.', t.direction === 'portrait' ? 'vertical' : 'horizontal');
      if (!gallery?.id) throw new Error('Gallery creation returned no ID.');
      state.devices[t.device.id] = { galleryId: gallery.id, items: {} };
      await writeJSON(stateFile, state); // Recover the same playlist after a partial run.
    }
    const record = state.devices[t.device.id] ||= { galleryId: gallery.id, items: {} };
    record.items ||= {};
    record.galleryId = gallery.id;
    record.alias = t.device.alias;
    record.orientation = t.direction;
    await writeJSON(stateFile, state);
    let cleaned = false;
    if (cleanupDevice || (Number.isFinite(t.device.freeSpace) && t.device.freeSpace < 500)) {
      log(`${t.device.alias}: freeing device storage (cloud originals are retained).`);
      await cleanDevice(api, t.device, gallery.id, log, t.plan.desired.map(x => x.id)); cleaned = true;
    }
    // Add first so a permission failure does not discard the old playlist.
    // Prune after each successful add to keep the final list <=100 even if a
    // later add fails. The cloud list can briefly contain one extra item.
    const remove = [...t.plan.remove].reverse();
    let size = t.existing.length;
    for (let i = 0; i < t.plan.add.length; i++) {
      const item = t.plan.add[i];
      await api.galleryAddItem(gallery.id, item.id);
      record.items[item.id] = { addedAt: new Date().toISOString(), featuredAt: item.featuredAt, sourceGalleryId: item.sourceGalleryId };
      size++;
      await writeJSON(stateFile, state);
      while (size > prepared.limit && remove.length) { await api.galleryRemoveItem(gallery.id, remove.shift().id); size--; }
      if ((i + 1) % 10 === 0 || i + 1 === t.plan.add.length) log(`${t.device.alias}: added ${i + 1}/${t.plan.add.length} images.`);
    }
    for (const item of remove) await api.galleryRemoveItem(gallery.id, item.id);
    await api.gallerySort(gallery.id, t.plan.desired.map(x => x.id));
    const actual = await api.galleryItems(gallery.id);
    const wanted = t.plan.desired.map(x => String(x.id)).sort();
    if (JSON.stringify(actual.map(x => String(x.id)).sort()) !== JSON.stringify(wanted)) throw new Error(`Playlist ${gallery.id} verification failed; device transfer stopped.`);
    try { await api.deviceAddGallery(t.device.id, gallery.id); }
    catch (error) {
      if (!error.insufficientStorage || cleaned) throw error;
      log(`${t.device.alias}: transfer needs storage; removing older device content and retrying.`);
      await cleanDevice(api, t.device, gallery.id, log, t.plan.desired.map(x => x.id));
      await api.deviceAddGallery(t.device.id, gallery.id);
    }
    await api.deviceUpdate(t.device.id, { currentGallery: gallery.id });
    await api.deviceSync(t.device.id);
    const now = new Date().toISOString();
    record.items = Object.fromEntries(t.plan.desired.map((item, i) => [item.id, record.items[item.id] || { addedAt: new Date(Date.now() - i).toISOString(), featuredAt: item.featuredAt, sourceGalleryId: item.sourceGalleryId }]));
    record.lastSuccess = now;
    await writeJSON(stateFile, state);
    log(`${t.device.alias}: verified ${actual.length} images; playlist ${gallery.id} sent to device.`);
  }
}

async function sync(api, config, stateFile, options = {}) {
  const state = await readJSON(stateFile, { version: 1, devices: {} });
  const log = options.log || console.log;
  const prepared = await prepare(api, config, state, log);
  for (const t of prepared.targets) {
    if (options.cleanupDevice || (Number.isFinite(t.device.freeSpace) && t.device.freeSpace < 500)) {
      log(`${t.device.alias}: device-only storage cleanup planned; ${t.device.galleryIds?.length || 0} attached playlists, ${t.device.itemIds?.length || 0} individually added images will be considered.`);
    }
  }
  if (options.apply) await applyPrepared(api, prepared, state, stateFile, options);
  else log('Dry run: no playlists or devices changed. Use --apply to sync.');
  return prepared;
}
module.exports = { validateConfig, prepare, cleanDevice, applyPrepared, sync };
