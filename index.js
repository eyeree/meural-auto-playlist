const path = require('node:path');
const { parseArgs } = require('node:util');
const { Auth, importBrowser } = require('./auth');
const { readJSON, withLock } = require('./store');
const Meural = require('./meural');
const { sync } = require('./sync');

async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'cleanup-device': { type: 'boolean' }, 'refresh': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, cdp: { type: 'string', default: '9222' },
    config: { type: 'string', default: path.join(__dirname, 'meural.config.json') },
    'data-dir': { type: 'string', default: path.join(__dirname, '.meural') },
    'feed-pages': { type: 'string' }
  } });
  const command = positionals[0] || 'sync';
  if (values.help) {
    console.log(`Usage: node index.js <command> [options]
  auth --cdp 9222       Import tokens from the signed-in Meural browser tab
  auth --refresh       Verify token refresh without Chrome
  devices              List devices, orientations, and storage
  feeds                List public feed playlists (metadata only)
  sync                 Preview changes; default is a dry run
  sync --apply         Apply changes and send playlists to devices
  sync --apply --cleanup-device  Also remove old device content
Options: --config FILE --data-dir DIR --feed-pages N --dry-run
Weekly scheduling instructions: README.md`);
    return;
  }
  if (positionals.length > 1 || !['auth','devices','feeds','sync'].includes(command)) throw new Error('Unknown command. Use --help.');
  if (values.apply && values['dry-run']) throw new Error('Choose either --apply or --dry-run.');
  const directory = path.resolve(values['data-dir']);
  await withLock(path.join(directory, 'run.lock'), async () => {
    const authFile = path.join(directory, 'auth.json');
    const auth = new Auth(authFile);
    if (command === 'auth') {
      if (values.refresh) { await auth.token(true); console.log('NETGEAR token refresh succeeded; Chrome is not required.'); }
      else { await importBrowser(authFile, values.cdp); console.log('Imported Meural session into the private auth file. Token values were not printed.'); }
      return;
    }
    const api = new Meural(auth);
    if (command === 'devices') {
      console.log(JSON.stringify((await api.devices()).map(d=>({id:d.id,alias:d.alias,orientation:d.orientation,currentGallery:d.currentGallery,freeSpaceMB:d.freeSpace})),null,2));
      return;
    }
    const config = await readJSON(values.config);
    if (values['feed-pages'] !== undefined) config.feedPages = Number(values['feed-pages']);
    require('./sync').validateConfig(config);
    if (command === 'feeds') {
      const seen = new Set();
      for (let page = 1; page <= config.feedPages; page++) {
        const response = await api.feedPage(page);
        if (!Array.isArray(response.data) || typeof response.isLast !== 'boolean') throw new Error('Unexpected feed response.');
        for (const p of response.data) if (p.postType === 'gallery' && p.post?.isPublic === true && !seen.has(String(p.post.id))) {
          seen.add(String(p.post.id));
          console.log(JSON.stringify({id:p.post.id,name:p.post.name,orientation:p.post.orientation,featuredAt:p.post.featuredAt,itemCount:p.post.itemCount}));
        }
        if (response.isLast) break;
      }
      return;
    }
    await sync(api, config, path.join(directory, 'state.json'), {
      apply: !!values.apply, cleanupDevice: !!values['cleanup-device']
    });
  });
}

if (require.main === module) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { main };
