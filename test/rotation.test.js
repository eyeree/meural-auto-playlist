const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { availableWithoutPurchase, planPlaylist, collectFeed } = require('../planner');
const { sync } = require('../sync');
const { readJSON, writeJSON, withLock } = require('../store');
const { latestWeeklyRun, needsWeeklyRun } = require('../schedule');
const { scheduleLines } = require('../install-weekly');
const image = (id, extra = {}) => ({ id, type: 'image', orientation: 'portrait', isPublic: true, nonsubscriberPrice: 0, subscriberPrice: 0, ...extra });
const quiet = () => {};

test('Linux lock survives a live legacy owner, migrates a dead owner, and releases after forced termination', { skip: process.platform !== 'linux' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meural-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.lock');
  await fs.writeFile(file, String(process.pid));
  await assert.rejects(withLock(file, async () => assert.fail('legacy owner still running')), error => error.code === 'ELOCKED');
  await fs.writeFile(file, '999999999');
  await withLock(file, async () => {});
  assert.equal((await readJSON(file)).lock, 'flock');
  // Kill only the helper itself while it holds the OS lock. No stale-file
  // deletion is necessary to acquire the next lock, even after SIGKILL.
  const killed = spawnSync('flock', ['--no-fork', file, 'sh', '-c', 'kill -KILL $$'], { timeout: 3000 });
  assert.equal(killed.signal, 'SIGKILL');
  await withLock(file, async () => {});
});

test('Pacific Sunday boundary and daylight-saving changes produce correct weekly deadlines', () => {
  for (const [now, due] of [
    ['2026-10-25T15:59:59Z', '2026-10-18T16:00:00.000Z'],
    ['2026-10-25T16:00:00Z', '2026-10-25T16:00:00.000Z'],
    ['2026-10-26T20:00:00Z', '2026-10-25T16:00:00.000Z'],
    ['2026-11-01T16:59:59Z', '2026-10-25T16:00:00.000Z'],
    ['2026-11-01T17:00:00Z', '2026-11-01T17:00:00.000Z'],
    ['2026-03-08T16:00:00Z', '2026-03-08T16:00:00.000Z'],
    ['2027-01-01T00:00:00Z', '2026-12-27T17:00:00.000Z']
  ]) assert.equal(latestWeeklyRun(new Date(now)), due);
  assert.equal(needsWeeklyRun({}, '2026-10-25T16:00:00Z'), true);
  assert.equal(needsWeeklyRun({ lastSuccess: 'invalid' }, '2026-10-25T16:00:00Z'), true);
  assert.equal(needsWeeklyRun({ lastSuccess: '2026-10-25T17:00:00Z' }, '2026-10-25T16:00:00Z'), false);
});

test('schedule checks at startup and hourly using absolute paths and a due guard', () => {
  const lines = scheduleLines('/opt/node', "/home/user/Meural's folder");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('0 * * * * '));
  assert.ok(lines[1].startsWith('@reboot '));
  assert.ok(lines.every(line => line.includes('sync --apply --scheduled') && line.includes("Meural'\\''s folder") && line.endsWith('# meural-weekly-feed')));
});

test('eligibility accepts only explicitly free, sampler, or zero subscriber-price images', () => {
  assert.equal(availableWithoutPurchase(image(1)), true);
  const paid = image(2, { nonsubscriberPrice: 395, subscriberPrice: 0 });
  assert.equal(availableWithoutPurchase(paid), false);
  assert.equal(availableWithoutPurchase(paid, true), true);
  assert.equal(availableWithoutPurchase(image(3, { nonsubscriberPrice: 395, subscriberPrice: 199 }), true), false);
  for (const price of [null, undefined, '', ' ', -1, 'unknown']) {
    assert.equal(availableWithoutPurchase(image(4, { nonsubscriberPrice: price, subscriberPrice: price }), true), false);
  }
  assert.equal(availableWithoutPurchase(image(5, { nonsubscriberPrice: 395, isSampler: true })), true);
  assert.equal(availableWithoutPurchase(image(6, { isPublic: false })), false);
  assert.equal(availableWithoutPurchase(image(7, { type: 'video' })), false);
});

test('rotation exhausts unseen images, then returns the oldest set without losing history', () => {
  const pool = [image(1), image(2), image(3), image(4)], history = {};
  let current = [], first;
  for (let week = 1; week <= 3; week++) {
    const plan = planPlaylist(current, pool, 'portrait', history, 2);
    if (week === 1) first = plan.desired.map(x => x.id);
    if (week === 2) assert.ok(plan.desired.every(x => !first.includes(x.id)));
    if (week === 3) assert.deepEqual(plan.desired.map(x => x.id), first);
    current = plan.desired;
    for (const item of current) history[item.id] = { lastShownAt: `2026-10-${String(week).padStart(2, '0')}` };
  }
  assert.equal(Object.keys(history).length, 4);
});

test('feed scans older pages beyond one full set and filters prices for membership', async () => {
  const seen = [];
  const api = {
    feedPage: async page => ({ isLast: page === 2, data: [{ postType: 'gallery', post: { id: page, isPublic: true, featuredAt: `2026-10-0${3-page}` } }] }),
    galleryItems: async id => { seen.push(id); return [image(id), image(id+10, { nonsubscriberPrice: 10, subscriberPrice: 0 }), image(id+20, { nonsubscriberPrice: 10, subscriberPrice: 5 })]; }
  };
  const feed = await collectFeed(api, 2, quiet, { eligible: item => availableWithoutPurchase(item, true) });
  assert.equal(feed.complete, true);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(feed.candidates.map(x => x.id), [1, 11, 2, 12]);
});

async function fixture(t, count = 1) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meural-rotation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const config = { maxImages: 2, feedPages: 2, devices: Array.from({ length: count }, (_, i) => ({ id: i+10, orientation: 'portrait', playlistName: `P${i}` })) };
  const galleries = new Map(config.devices.map(t => [t.id+100, [image(t.id*10), image(t.id*10+1)]]));
  const state = { userId: 7, devices: Object.fromEntries(config.devices.map(t => [t.id, { galleryId: t.id+100, lastSuccess: '2026-10-14T20:00:00Z', items: Object.fromEntries(galleries.get(t.id+100).map(x => [x.id, { addedAt: '2026-10-14T20:00:00Z' }])) }])) };
  await writeJSON(file, state);
  const calls = [];
  const api = {
    getData: async () => ({ id: 7, subscriptionIsActive: true }),
    devices: async () => config.devices.map(t => ({ id: t.id, alias: t.playlistName, orientation: 'vertical' })),
    galleries: async () => [...galleries].map(([id]) => ({ id })),
    feedPage: async () => ({ isLast: true, data: [{ postType: 'gallery', post: { id: 1, isPublic: true } }] }),
    galleryItems: async id => id === 1 ? [image(1), image(2), image(3), image(4)] : [...galleries.get(id)],
    galleryAddItem: async (id, item) => { calls.push(['add', id, item]); galleries.get(id).push(image(item)); },
    galleryRemoveItem: async (id, item) => { calls.push(['remove', id, item]); galleries.set(id, galleries.get(id).filter(x => x.id !== item)); },
    gallerySort: async () => {}, deviceAddGallery: async id => { calls.push(['transfer', id]); }, deviceSync: async () => {}
  };
  return { file, config, api, calls };
}

test('successful selections stay fixed within a week, rotate next week and retain removed-image history', async t => {
  const { file, config, api, calls } = await fixture(t);
  const options = { apply: true, log: quiet, now: new Date('2026-10-26T20:00:00Z') };
  await sync(api, config, file, options);
  const first = await readJSON(file);
  assert.deepEqual(first.devices[10].selection, [1, 2]);
  assert.equal(Object.keys(first.devices[10].history).length, 4);
  calls.length = 0;
  await sync(api, config, file, options);
  assert.ok(!calls.some(([action]) => ['add','remove'].includes(action)));
  const result = await sync({}, config, file, { ...options, scheduled: true });
  assert.equal(result.skipped, true);
  await sync(api, config, file, { ...options, now: new Date('2026-11-02T20:00:00Z') });
  const next = await readJSON(file);
  assert.deepEqual(next.devices[10].selection, [3, 4]);
  assert.equal(Object.keys(next.devices[10].history).length, 6);
});

test('partial device failure retries its saved batch without rotating the successful device again', async t => {
  const { file, config, api, calls } = await fixture(t, 2);
  const options = { apply: true, scheduled: true, log: quiet, now: new Date('2026-10-26T20:00:00Z') };
  const transfer = api.deviceAddGallery;
  api.deviceAddGallery = async id => { if (id === 11) throw Error('offline'); return transfer(id); };
  await assert.rejects(sync(api, config, file, options), /offline/);
  const partial = await readJSON(file);
  assert.deepEqual(partial.devices[11].pending.itemIds, [1, 2]);
  assert.equal(partial.devices[10].pending, undefined);
  api.deviceAddGallery = transfer;
  calls.length = 0;
  await sync(api, config, file, options);
  assert.deepEqual(calls.filter(([action]) => action === 'transfer'), [['transfer', 11]]);
  const done = await readJSON(file);
  assert.deepEqual(done.devices[11].selection, [1, 2]);
  assert.equal(done.devices[11].pending, undefined);
});
