const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { orientation, matches, planPlaylist, collectFeed } = require('../planner');
const { Auth } = require('../auth');
const Meural = require('../meural');
const { writeJSON, readJSON, withLock } = require('../store');
const { applyPrepared, cleanDevice, validateConfig, sync } = require('../sync');
const image = (id, direction = 'portrait', extra = {}) => ({ id, type:'image', orientation:direction, isPublic:true, nonsubscriberPrice:0, subscriberPrice:0, ...extra });
const quiet = () => {};

test('device orientation aliases and per-image orientation in mixed galleries', () => {
  assert.equal(orientation('vertical'), 'portrait');
  assert.equal(orientation('horizontal'), 'landscape');
  assert.equal(matches(image(1), 'portrait'), true);
  assert.equal(matches(image(1,'landscape'), 'portrait'), false);
  assert.equal(matches(image(1,'square'), 'portrait'), false);
  assert.equal(matches(image(1,null,{originalWidth:100,originalHeight:200}), 'portrait'), true);
  assert.equal(matches(image(1,'portrait',{type:'video'}), 'portrait'), false);
});

test('100-image cap, duplicate removal, public filtering and unseen images preferred next time', () => {
  const candidates = Array.from({length:120},(_,i)=>image(i+1));
  const first = planPlaylist([], [image(999,'portrait',{isPublic:false}), ...candidates, candidates[0]], 'portrait');
  assert.equal(first.desired.length, 100);
  assert.deepEqual(first.desired.map(x=>x.id), candidates.slice(0,100).map(x=>x.id));
  const second = planPlaylist(first.desired, candidates, 'portrait');
  assert.equal(second.add.length,20); assert.equal(second.remove.length,20);
  assert.deepEqual(second.desired.slice(0,20).map(x=>x.id), candidates.slice(100).map(x=>x.id));
});

test('unseen images come first, followed by least recently shown images', () => {
  const current = [image(1),image(2),image(3)];
  const history = {1:{addedAt:'2026-01-01'},2:{addedAt:'2026-02-01'},3:{addedAt:'2026-03-01'}};
  const plan = planPlaylist(current,[image(4)],'portrait',history,3);
  assert.deepEqual(plan.desired.map(x=>x.id),[4,1,2]);
  assert.deepEqual(plan.remove.map(x=>x.id),[3]);
});

test('feed sorts feature dates and includes mixed-gallery images while excluding articles/private galleries', async () => {
  const calls=[];
  const api={feedPage:async()=>({isLast:true,data:[
    {postType:'gallery',post:{id:1,isPublic:true,featuredAt:'2025-01-01'}},
    {postType:'article',post:{id:2,isPublic:true}},
    {postType:'gallery',post:{id:3,isPublic:false}},
    {postType:'gallery',post:{id:4,isPublic:true,orientation:'mixed',featuredAt:'2026-01-01'}}
  ]}),galleryItems:async id=>{calls.push(id);return [image(id),image(id+10,'landscape')]}};
  const feed=await collectFeed(api,1);
  assert.deepEqual(calls,[4,1]);
  assert.deepEqual(feed.candidates.map(x=>x.id),[4,14,1,11]);
});

test('pagination refuses repeated pages instead of silently planning from partial data', async () => {
  const api=new Meural({token:async()=> 'unused'},{fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:[image(1)],isLast:false})})});
  await assert.rejects(api.galleryItems(1),/Repeated page/);
});

test('401 triggers one refresh and preserves current API headers', async () => {
  const refresh=[], headers=[];
  const api=new Meural({token:async force=>{refresh.push(force);return 'not-a-real-token'}},{fetchImpl:async(_,options)=>{
    headers.push(options.headers);return {status:headers.length===1?401:200,ok:headers.length>1,json:async()=>({data:[]})};
  }});
  await api.getData('/user');
  assert.deepEqual(refresh,[false,true]);
  assert.equal(headers[1]['x-meural-api-version'],'4');
});

test('refresh persists rotated credentials privately; errors never include response tokens', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meural-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'auth.json');await writeJSON(file,{refreshToken:'old',clientId:'public-app'});
  const auth=new Auth(file,async(_,options)=>{
    assert.equal(options.headers.Authorization,'Bearer old');
    return {ok:true,json:async()=>({data:{accessToken:'new-access',refreshToken:'rotated'}})};
  });
  assert.equal(await auth.token(true),'new-access');
  assert.equal((await readJSON(file)).refreshToken,'rotated');
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);
  const bad=new Auth(file,async()=>({ok:false,status:403,text:async()=> 'SECRET'}));
  await assert.rejects(bad.token(true),e=>!e.message.includes('SECRET')&&e.message.includes('403'));
});

test('exclusive run lock prevents overlap and releases after failure', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meural-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'lock');
  await assert.rejects(withLock(file,async()=>{
    await assert.rejects(withLock(file,async()=>{}), error => error.code === 'ELOCKED' && /Another run/.test(error.message));throw Error('failure');
  }),/failure/);
  await withLock(file,async()=>{});
});

test('cleanup removes only old device associations, preserving the managed gallery and cloud content', async () => {
  const calls=[];
  await cleanDevice({getData:async()=>({galleryIds:[1,2],itemIds:[3]}),request:async(...args)=>calls.push(args)}, {id:10}, 2, quiet);
  assert.deepEqual(calls,[['DELETE','/devices/10/galleries/1'],['DELETE','/devices/10/items/3']]);
});

test('cleanup preserves individually-added images needed by the new managed playlist', async () => {
  const calls=[];
  await cleanDevice({getData:async()=>({galleryIds:[],itemIds:[3,4]}),request:async(...args)=>calls.push(args)}, {id:10}, 2, quiet, [3]);
  assert.deepEqual(calls,[['DELETE','/devices/10/items/4']]);
});

test('transient GET errors retry, but ambiguous writes are never replayed', async () => {
  let count=0;
  const api=new Meural({token:async()=> 'unused'},{fetchImpl:async()=>{if(++count===1)throw Error('reset');return {ok:true,status:200,json:async()=>({data:[]})}}});
  assert.deepEqual(await api.getData('/user'),[]);
  assert.equal(count,2);
  count=0;api.fetch=async()=>{count++;throw Error('reset')};
  await assert.rejects(api.request('POST','/galleries/1/items/2'),/did not complete/);
  assert.equal(count,1);
});

test('lost write responses are reconciled by reading server state instead of duplicating additions', async () => {
  let writes=0;
  const api=new Meural({token:async()=> 'unused'},{fetchImpl:async(_,options)=>{
    if(options.method==='POST'){writes++;throw Error('reply lost')}
    return {ok:true,status:200,json:async()=>({data:[image(2)],isLast:true})};
  }});
  assert.deepEqual(await api.galleryAddItem(1,2),{recovered:true});
  assert.equal(writes,1);
});

test('failed addition stops before removing old images or transferring a playlist', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meural-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const api={galleryAddItem:async()=>{throw Error('denied')},galleryRemoveItem:async()=>assert.fail('must not prune'),deviceAddGallery:async()=>assert.fail('must not transfer')};
  const prepared={userId:1,limit:1,targets:[{target:{},device:{id:10,alias:'frame'},saved:{},direction:'portrait',gallery:{id:2},existing:[image(1)],plan:{desired:[image(2)],add:[image(2)],remove:[image(1)]}}]};
  await assert.rejects(applyPrepared(api,prepared,{devices:{}},path.join(dir,'state.json'),{log:quiet}),/denied/);
});

test('apply verifies cap, transfers and selects correct gallery, and retries only storage failures', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meural-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const calls=[];let transfer=0;
  const api={galleryAddItem:async()=>calls.push('add'),galleryRemoveItem:async()=>calls.push('remove'),gallerySort:async()=>calls.push('sort'),galleryItems:async()=>[image(2)],
    deviceAddGallery:async(id,gallery)=>{assert.equal(id,10);assert.equal(gallery,2);if(++transfer===1)throw Object.assign(Error('full'),{insufficientStorage:true});calls.push('transfer')},
    getData:async()=>({galleryIds:[2,9],itemIds:[]}),request:async(method,url)=>calls.push(url),deviceSync:async()=>calls.push('sync')};
  const prepared={userId:1,limit:1,targets:[{target:{},device:{id:10,alias:'frame'},saved:{},direction:'portrait',gallery:{id:2},existing:[image(1)],plan:{desired:[image(2)],add:[image(2)],remove:[image(1)]}}]};
  const state={devices:{}};
  await applyPrepared(api,prepared,state,path.join(dir,'state.json'),{log:quiet});
  assert.deepEqual(calls,['add','remove','sort','/devices/10/galleries/9','transfer','sync']);
  assert.ok(state.devices[10].lastSuccess);
});

test('config rejects invalid caps and shared target names', () => {
  assert.throws(()=>validateConfig({maxImages:101,feedPages:1,devices:[]}),/maxImages/);
  assert.throws(()=>validateConfig({maxImages:100,feedPages:1,devices:[{id:1,orientation:'portrait',playlistName:'same'},{id:2,orientation:'landscape',playlistName:'same'}]}),/unique/);
});

test('dry run plans both orientations without writing state or calling mutation APIs', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meural-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const config={maxImages:100,feedPages:1,devices:[{id:10,orientation:'portrait',playlistName:'P'},{id:20,orientation:'landscape',playlistName:'L'}]};
  const api={getData:async()=>({id:7}),devices:async()=>[{id:10,orientation:'vertical'},{id:20,orientation:'horizontal'}],galleries:async()=>[],
    feedPage:async()=>({isLast:true,data:[{postType:'gallery',post:{id:1,isPublic:true}}]}),galleryItems:async()=>[image(1),image(2,'landscape')]};
  const file=path.join(dir,'state.json');
  const result=await sync(api,config,file,{log:quiet});
  assert.deepEqual(result.targets.map(t=>t.plan.desired.map(x=>x.id)),[[1],[2]]);
  await assert.rejects(fs.access(file),{code:'ENOENT'});
  api.feedPage=async()=>({isLast:true,data:[]});
  await assert.rejects(sync(api,config,file,{apply:true,log:quiet}),/No public portrait/);
});

test('account identity mismatch stops before device access or writes', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meural-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');await writeJSON(file,{userId:7,devices:{}});
  const config={maxImages:100,feedPages:1,devices:[{id:10,orientation:'portrait',playlistName:'P'}]};
  await assert.rejects(sync({getData:async()=>({id:8})},config,file,{apply:true,log:quiet}),/another Meural account/);
});
