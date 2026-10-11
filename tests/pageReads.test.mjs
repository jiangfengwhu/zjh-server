import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/index.ts'],bundle:true,platform:'node',format:'esm',write:false,banner:{js: "import {createRequire} from 'node:module'; const require=createRequire(process.cwd()+'/tests/pageReads.test.mjs');"},plugins:[{name:'context',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'context',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}'}));}}]});
const {default:worker,Workshop,Posts}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64')).catch(error=>{console.error(error.message);process.exit(1)});
const indexes=await build({entryPoints:['src/readIndexes.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {MarketIndex,TimelineIndex}=await import('data:text/javascript;base64,'+Buffer.from(indexes.outputFiles[0].text).toString('base64'));
const alice='11111111-1111-4111-8111-111111111111',bob='22222222-2222-4222-8222-222222222222';
const token='a'.repeat(64),headers={Authorization:'Bearer '+token};
function context(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)');let lists=0;
 const sql={exec(q,...values){const st=db.prepare(q);const rows=st.columns().length?st.all(...values):(st.run(...values),[]);return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0]},[Symbol.iterator]:()=>rows[Symbol.iterator]()}}};
 let tx=0;const storage={sql,
 async get(keys){if(Array.isArray(keys)){assert.ok(keys.length<=128);const values=new Map();for(const key of keys){const row=db.prepare('SELECT value FROM kv WHERE key=?').get(key);if(row)values.set(key,JSON.parse(row.value));}return values;}const row=db.prepare('SELECT value FROM kv WHERE key=?').get(keys);return row?JSON.parse(row.value):undefined},
 async put(key,value){for(const [k,v] of typeof key==='string'?[[key,value]]:Object.entries(key))db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?)').run(k,JSON.stringify(v))},
 async delete(keys){let n=0;for(const key of Array.isArray(keys)?keys:[keys])n+=db.prepare('DELETE FROM kv WHERE key=?').run(key).changes;return n},
 async list(options={}){lists++;let rows=db.prepare('SELECT * FROM kv ORDER BY key').all().filter(r=>(!options.prefix||r.key.startsWith(options.prefix))&&(!options.startAfter||r.key>options.startAfter)&&(!options.end||r.key<options.end)&&(!options.start||r.key>=options.start));if(options.reverse)rows.reverse();return new Map(rows.slice(0,options.limit??rows.length).map(r=>[r.key,JSON.parse(r.value)]))},
 async transaction(work){const name='t'+(++tx);db.exec('SAVEPOINT '+name);try{const value=await work(storage);db.exec('RELEASE '+name);return value}catch(e){db.exec('ROLLBACK TO '+name);db.exec('RELEASE '+name);throw e}},
 transactionSync(work){const name='t'+(++tx);db.exec('SAVEPOINT '+name);try{const value=work();db.exec('RELEASE '+name);return value}catch(e){db.exec('ROLLBACK TO '+name);db.exec('RELEASE '+name);throw e}},
 async getAlarm(){return null},async setAlarm(){},async deleteAlarm(){},async deleteAll(){db.exec('DELETE FROM kv')}
 };const pending=[];return {storage,blockConcurrencyWhile:work=>work(),waitUntil:p=>pending.push(Promise.resolve(p).catch(()=>{})),getWebSockets:()=>[],db,lists:()=>lists,flush:()=>Promise.all(pending),close:()=>db.close()};
}
function fixture(){const workshopCtx=context(),postsCtx=context();const env={ACCOUNTS:{getByName:()=>({fetch:async req=>{if(new URL(req.url).pathname==='/internal/profiles'){const {ids}=await req.json();return Response.json({profiles:ids.map(id=>({id,name:id===alice?'Alice':'Bob',avatarUrl:null}))});}return Response.json(req.headers.get('Authorization')==='Bearer '+token?{user:{id:alice,name:'Alice',avatarUrl:null}}:{},{status:req.headers.get('Authorization')==='Bearer '+token?200:401})}})},CATALOG:{get:async()=>null},BLOBS:{},WORKSHOP:{getByName:()=>workshop},POSTS:{getByName:()=>posts}};const workshop=new Workshop(workshopCtx,env),posts=new Posts(postsCtx,env);return {env,workshop,posts,workshopCtx,postsCtx,call:(path,auth=false)=>worker.fetch(new Request('https://test'+path,{headers:auth?headers:{}}),env),close(){workshopCtx.close();postsCtx.close()}};}
const market=(id,title='离谱鉴宝',at=100,author=bob)=>({manifest:{appId:id,releaseId:'b'.repeat(64),appName:title,description:'简介',accent:'#fff',source:{commit:'c'.repeat(40),dirty:false}},title,summary:'AI 萌星物语 😺',authorId:author,authorName:'Bob',publishedAt:at,category:'other'});

test('work deletion enforces ownership, removes listings and revokes late publication without deleting immutable references',async()=>{
 const f=fixture();try{
  const removed=[];f.env.CATALOG.delete=async key=>{removed.push(key)};
  f.env.OFFICIAL_PUBLISH_TOKEN=token;
  const appId='app-delete',other='app-keep';
  const task={appId,ownerId:alice,session:'',token:'test',branch:'main',phase:'paused',startedAt:100,title:'删除测试',wish:'test'};
  const entry=market(appId,'删除测试',100,alice),version=entry.manifest.releaseId;
  await f.workshopCtx.storage.put({['task:'+appId]:task,['owner:'+alice+':'+appId]:task,['shared:'+appId]:entry,['candidate:'+appId]:entry.manifest,['allocation:'+appId]:{base:2000000},['published:'+appId+':'+version]:true,['work-notice:'+appId+':round:true']:{appId},['quota:'+alice]:{day:1,count:3,reservations:{[appId]:Date.now()+60000}}});
  const foreign={...task,appId:other,ownerId:bob};await f.workshopCtx.storage.put({['task:'+other]:foreign,['owner:'+bob+':'+other]:foreign,['shared:'+other]:market(other)});
  const request=(id,auth=true)=>new Request('https://test/v1/works/'+id,{method:'DELETE',headers:auth?headers:{}});
  assert.equal((await worker.fetch(request(appId,false),f.env)).status,401);
  assert.equal((await worker.fetch(request(other),f.env)).status,403);
  assert.equal((await worker.fetch(request('jolly'),f.env)).status,403);
  assert.equal((await worker.fetch(request('missing'),f.env)).status,404);
  assert.equal((await f.workshopCtx.storage.get('task:'+appId)).appId,appId);
  assert.deepEqual(await(await worker.fetch(request(appId),f.env)).json(),{deleted:true,appId});
  for(const key of ['task:'+appId,'owner:'+alice+':'+appId,'shared:'+appId,'candidate:'+appId,'work-notice:'+appId+':round:true'])assert.equal(await f.workshopCtx.storage.get(key),undefined);
  assert.equal((await f.workshopCtx.storage.get('quota:'+alice)).count,3);
  assert.deepEqual((await f.workshopCtx.storage.get('quota:'+alice)).reservations,{});
  assert.equal((await f.workshopCtx.storage.get('allocation:'+appId)).base,2000000);
  assert.equal(await f.workshopCtx.storage.get('published:'+appId+':'+version),true);
  assert.equal((await f.workshopCtx.storage.get('task:'+other)).ownerId,bob);
  const listing=await(await f.call('/v1/market')).json();assert.deepEqual(listing.applications.map(a=>a.manifest.appId),[other]);
  const works=await(await f.call('/v1/works',true)).json();assert.deepEqual(works.works,[]);assert.deepEqual(works.deletedAppIds,[appId]);
  const gallery=await(await f.call('/v1/me/works',true)).json();assert.equal(gallery.totalCount,0);assert.deepEqual(gallery.deletedAppIds,[appId]);
  assert.equal((await f.call('/v1/applications/'+appId+'/public')).status,404);
  await assert.rejects(()=>f.workshop.saveTask(task),/作品已删除/);
  assert.equal(await f.workshop.publisher(new Request('https://test',{headers}),appId),false);
  const resume=new Request('https://test/v1/workshop',{method:'POST',headers,body:JSON.stringify({appId,action:'status'})});assert.equal((await worker.fetch(resume,f.env)).status,410);
  const publish=new Request('https://test/v1/official-release',{method:'POST',headers,body:JSON.stringify({appId,releaseId:version})});assert.equal((await worker.fetch(publish,f.env)).status,410);
  assert.equal((await worker.fetch(request(appId),f.env)).status,200);
  await f.workshopCtx.flush();assert.ok(removed.every(key=>key==='v1/applications/'+appId+'/latest'));
 }finally{f.close()}
});

test('work deletion filters a list request that was already waiting for progress',async()=>{
 const f=fixture();try{
  f.env.CATALOG.delete=async()=>{};
  const appId='app-delete-race';const task={appId,ownerId:alice,session:'',token:'test',branch:'main',phase:'working',startedAt:100,wish:'test'};
  await f.workshopCtx.storage.put({['task:'+appId]:task,['owner:'+alice+':'+appId]:task});
  let release,entered;const started=new Promise(r=>{entered=r});const blocked=new Promise(r=>{release=r});
  f.workshop.refreshSummary=()=>{entered();return blocked};
  const pending=f.call('/v1/works?view=gallery&refresh=1',true);await started;
  assert.equal((await worker.fetch(new Request('https://test/v1/works/'+appId,{method:'DELETE',headers}),f.env)).status,200);
  release();const page=await(await pending).json();assert.deepEqual(page.works,[]);assert.equal(page.totalCount,0);assert.deepEqual(page.deletedAppIds,[appId]);
  await f.workshopCtx.flush();
 }finally{f.close()}
});

test('batch notification reads are idempotent, account-scoped and exclude later arrivals',async()=>{
 const f=fixture();try{
  const ids=[1,2,3,4].map(n=>String(n).padStart(64,'0'));
  const keys=ids.map(id=>'notice:'+alice+':0000000000001:'+id);
  for(let i=0;i<ids.length;i++)await f.postsCtx.storage.put({[keys[i]]:{id:ids[i],kind:i===0?'work-ready':'like',read:i===2,createdAt:i===3?Date.now()+60000:1},['notice-id:'+alice+':'+ids[i]]:keys[i]});
  const foreign='notice:'+bob+':0000000000001:'+ids[0];await f.postsCtx.storage.put({[foreign]:{kind:'like',read:false,createdAt:1},['notice-id:'+alice+':'+String(5).padStart(64,'0')]:foreign});
  await f.postsCtx.storage.put({['notice-unread:'+alice]:3,['notice-unread-categories:'+alice]:{creation:1,interaction:2}});
  const request=()=>new Request('https://test/v1/notifications/read',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({ids:[...ids,ids[0],String(5).padStart(64,'0')]})});
  let result=await(await f.posts.fetch(request())).json();assert.deepEqual(result.unreadByCategory,{creation:0,interaction:1});assert.equal(result.unreadCount,1);
  assert.equal((await f.postsCtx.storage.get(keys[3])).read,false);assert.equal((await f.postsCtx.storage.get(foreign)).read,false);
  result=await(await f.posts.fetch(request())).json();assert.equal(result.unreadCount,1);
 }finally{await f.postsCtx.flush();f.close()}
});

test('batch notification records and counters roll back together on write failure',async()=>{
 const f=fixture();try{
  const id='1'.repeat(64),key='notice:'+alice+':0000000000001:'+id;
  await f.postsCtx.storage.put({[key]:{id,kind:'like',read:false,createdAt:1},['notice-id:'+alice+':'+id]:key,['notice-unread:'+alice]:1,['notice-unread-categories:'+alice]:{creation:0,interaction:1}});
  const original=f.postsCtx.storage.put;f.postsCtx.storage.put=async(key,value)=>{if(typeof key==='object'&&Object.hasOwn(key,'notice-unread:'+alice))throw Error('counter write failure');return original(key,value)};
  const response=await f.posts.fetch(new Request('https://test/v1/notifications/read',{method:'POST',headers,body:JSON.stringify({ids:[id]})}));assert.equal(response.status,503);
  assert.equal((await f.postsCtx.storage.get(key)).read,false);assert.equal(await f.postsCtx.storage.get('notice-unread:'+alice),1);
  assert.deepEqual(await f.postsCtx.storage.get('notice-unread-categories:'+alice),{creation:0,interaction:1});
 }finally{await f.postsCtx.flush();f.close()}
});
test('market migration, Unicode substring, stable cursors, edit and withdrawal',async()=>{const c=context();try{await c.storage.put({'shared:app-a':market('app-a'),'shared:app-b':market('app-b','其他',100),'shared:jolly':market('jolly')});const index=new MarketIndex(c);await index.ensure();assert.equal(index.page({limit:1}).total,2);assert.deepEqual(index.page({query:'萌星',limit:10}).rows.map(r=>r.app_id),['app-a','app-b']);assert.equal(index.page({query:'😺',limit:10}).total,2);assert.equal(index.page({query:'宝 萌',limit:10}).total,0);const first=index.page({limit:1}).rows[0];assert.deepEqual(index.page({after:{at:first.at,id:first.app_id},limit:1}).rows.map(r=>r.app_id),['app-b']);index.put(market('app-a','新版'));assert.equal(index.page({query:'离谱',limit:10}).total,0);index.remove('app-b');assert.equal(index.page({}).total,1);const scans=c.lists();await new MarketIndex(c).ensure();assert.equal(c.lists(),scans)}finally{c.close()}});
test('canonical KV and SQL updates roll back together',async()=>{const c=context();try{const i=new MarketIndex(c);await i.ensure();await assert.rejects(c.storage.transaction(async st=>{await st.put('shared:app-a',market('app-a'));i.put(market('app-a'));throw Error('abort')}));assert.equal(await c.storage.get('shared:app-a'),undefined);assert.equal(i.page({}).total,0)}finally{c.close()}});
test('following index finds sparse older authors beyond 5000 posts and respects unfollow',async()=>{const c=context();try{for(let n=0;n<5100;n++)await c.storage.put('post:'+String(n).padStart(13,'0')+':'+String(n).padStart(64,'0'),{author:{id:n===5099?bob:alice}});await c.storage.put('follow:viewer:'+bob,true);const i=new TimelineIndex(c);await i.ensure();const scans=c.lists();assert.equal(i.posts({viewer:'viewer',limit:51}).length,1);assert.equal(i.posts({author:bob,limit:51}).length,1);i.follow('viewer',bob,false);assert.equal(i.posts({viewer:'viewer',limit:51}).length,0);assert.equal(c.lists(),scans);const plan=c.storage.sql.exec('EXPLAIN QUERY PLAN SELECT p.key FROM timeline_read p WHERE p.author_id IN (SELECT author_id FROM timeline_follow WHERE viewer=?) ORDER BY p.key LIMIT 51','viewer').toArray();assert.ok(plan.some(row=>row.detail.includes('timeline_read_author')));const key=i.posts({author:bob,limit:1})[0];i.removePost(key);assert.equal(i.posts({author:bob,limit:1}).length,0)}finally{c.close()}});
test('notification category index migrates and removes records',async()=>{const c=context();try{await c.storage.put({'notice:alice:1':{kind:'work-success'},'notice:alice:2':{kind:'like'}});const i=new TimelineIndex(c);await i.ensure();assert.deepEqual(i.notices('alice','creation',undefined,10),['notice:alice:1']);assert.deepEqual(i.notices('alice','interaction',undefined,10),['notice:alice:2']);i.removeNotice('notice:alice:1');assert.equal(i.notices('alice','creation',undefined,10).length,0)}finally{c.close()}});
test('discovery batches interaction state, comments first page, and account counts',async()=>{const f=fixture();try{await f.workshopCtx.storage.put('shared:app-a',market('app-a'));const response=await f.call('/v1/discovery',true);assert.equal(response.status,200);const page=await response.json();const app=page.applications[0];assert.equal(app.authorFollowing,false);assert.equal(app.interactionOwner,undefined);assert.ok(app.discussion.applicationDiscussion);assert.equal(app.discussion.author.id,bob);const comments=await f.call('/v1/application-discussions/app-a?comments=1',true);const detail=await comments.json();assert.equal(detail.post.id,app.discussion.id);assert.deepEqual(detail.comments,[]);assert.equal(detail.nextCursor,null);assert.equal((await f.call('/v1/account-counts')).status,401);assert.equal((await f.call('/v1/me/works')).status,401);assert.equal((await f.call('/v1/account-counts',true)).status,200);assert.equal((await f.call('/internal/application-interactions',true)).status,404)}finally{await f.workshopCtx.flush();await f.postsCtx.flush();f.close()}});
test('profile summary does not deliver posts or increment unseen views',async()=>{const f=fixture();try{await f.workshopCtx.storage.put('shared:app-a',market('app-a'));const summary=await (await f.call('/v1/profiles/'+bob+'?view=summary',true)).json();assert.equal(summary.applicationCount,1);assert.deepEqual(summary.posts,[]);assert.deepEqual(summary.applications,[]);assert.equal(f.postsCtx.db.prepare("SELECT count(*) n FROM kv WHERE key LIKE 'view:%'").get().n,0);const relationship=await (await f.call('/v1/profiles/'+bob+'?view=relationship',true)).json();assert.equal(relationship.following,false);assert.equal(relationship.posts,undefined)}finally{await f.workshopCtx.flush();await f.postsCtx.flush();f.close()}});
test('gallery pages omit recovery credentials and preserve legacy works contract',async()=>{const f=fixture();try{for(let n=0;n<26;n++){const appId='app-'+n,task={appId,ownerId:alice,session:'sessions/x',token:'private-token',phase:'working',startedAt:1000+n,title:'作品'+n,wish:'需求'};await f.workshopCtx.storage.put({['owner:'+alice+':'+appId]:task,['task:'+appId]:task})}let page=await (await f.call('/v1/me/works',true)).json();assert.equal(page.works.length,24);assert.equal(page.totalCount,26);assert.ok(page.summary);assert.equal(page.works[0].approvalToken,undefined);assert.equal(page.works[0].session,undefined);assert.ok(page.nextCursor);page=await(await f.call('/v1/me/works?cursor='+encodeURIComponent(page.nextCursor),true)).json();assert.equal(page.works.length,2);const legacy=await(await f.call('/v1/works',true)).json();assert.equal(legacy.works.length,26);assert.equal(legacy.works[0].approvalToken,'private-token')}finally{await f.workshopCtx.flush();await f.postsCtx.flush();f.close()}});
test('progress output cache isolates rounds and avoids repeat history traversal',async()=>{const f=fixture();try{let reads=0;f.workshop.activities=async(name,cursor)=>{reads++;return cursor?{activities:[{createTime:new Date(3000).toISOString(),agentMessaged:{agentMessage:'last'}}]}:{activities:[{createTime:new Date(1000).toISOString(),agentMessaged:{agentMessage:'old'}}],nextPageToken:'next'}};const task={appId:'app-a',session:'sessions/a',requestId:'round-a',startedAt:2000};const session={state:'COMPLETED',updateTime:'2026-10-09T00:00:00Z'};let value=await f.workshop.progressActivities(task,session);assert.equal(value.activities[0].agentMessaged.agentMessage,'last');assert.equal(reads,2);await f.workshop.progressActivities(task,session);assert.equal(reads,2);value=await f.workshop.progressActivities({...task,requestId:'round-b',startedAt:4000},session);assert.equal(value.activities.length,0);assert.equal(reads,4)}finally{f.close()}});

test('discovery social outage still returns published applications and 50-item batch respects storage limits',async()=>{const f=fixture();try{for(let n=0;n<50;n++)await f.workshopCtx.storage.put('shared:app-'+n,market('app-'+n));let response=await f.call('/v1/discovery?limit=50',true);let page=await response.json();assert.equal(page.applications.length,50);assert.ok(page.applications.every(item=>item.discussion));f.env.POSTS.getByName=()=>({fetch:async()=>new Response('unavailable',{status:503})});response=await f.call('/v1/discovery',true);page=await response.json();assert.equal(response.status,200);assert.equal(page.applications.length,24);assert.equal(page.applications[0].discussion,undefined)}finally{await f.workshopCtx.flush();await f.postsCtx.flush();f.close()}});
test('message incremental pages are pair-scoped and GET does not mark them read',async()=>{const f=fixture();try{const pair=[alice,bob].sort().join(':');for(let n=0;n<55;n++){const id=String(n+1).padStart(64,'0'),message={id,senderId:bob,body:'message '+n,createdAt:100+n},key='dm:'+pair+':'+String(100+n).padStart(13,'0')+':'+id;await f.postsCtx.storage.put({[key]:message,['dm-id:'+pair+':'+id]:key})}await f.postsCtx.storage.put('dm-unread:'+alice,55);const after=String(1).padStart(64,'0');let page=await(await f.call('/v1/messages/'+bob+'?after='+after,true)).json();assert.equal(page.messages.length,50);assert.equal(page.messages[0].createdAt,101);assert.equal(page.hasMoreNew,true);assert.equal(await f.postsCtx.storage.get('dm-unread:'+alice),55);page=await(await f.call('/v1/messages/'+bob+'?after='+page.messages.at(-1).id,true)).json();assert.equal(page.messages.length,4);assert.equal(page.hasMoreNew,false);assert.equal((await f.call('/v1/messages/33333333-3333-4333-8333-333333333333?after='+after,true)).status,404)}finally{await f.postsCtx.flush();f.close()}});


test('community can attach another authors public application with immutable entry params',async()=>{
 const f=fixture();try{
  await f.workshopCtx.storage.put('shared:app-share',market('app-share'));
  const selection={appId:'app-share',releaseId:'b'.repeat(64),params:{room:'房间 😺',level:3}};
  const publish=(application=selection,requestId='share-post-000001',auth=true)=>f.posts.fetch(new Request('https://test/v1/posts',{method:'POST',headers:{...(auth?headers:{}),'Content-Type':'application/json'},body:JSON.stringify({body:'',imageIds:[],requestId,application})}));
  let response=await publish();assert.equal(response.status,201);const first=await response.json();
  assert.equal(first.post.author.id,alice);assert.equal(first.post.application.author.id,bob);assert.deepEqual(first.post.application.params,selection.params);
  response=await publish();assert.equal(response.status,200);assert.equal((await response.json()).post.id,first.post.id);
  assert.equal((await publish({...selection,params:{level:4}})).status,409);
  assert.equal((await publish(selection,'share-post-000002',false)).status,401);
  assert.equal((await publish({...selection,appId:'app-private'},'share-post-000003')).status,404);
  assert.equal((await publish({...selection,releaseId:'c'.repeat(64)},'share-post-000004')).status,409);
  assert.equal((await publish({...selection,params:{text:'😺'.repeat(1024)}},'share-post-000005')).status,400);
 }finally{await f.workshopCtx.flush();await f.postsCtx.flush();f.close()}
});
test('friend cards preserve params, reject private applications and retry without duplicate messages',async()=>{
 const f=fixture();try{
  await f.workshopCtx.storage.put('shared:app-share',market('app-share'));
  const selection={appId:'app-share',releaseId:'b'.repeat(64),params:{level:5}};
  const send=(application=selection,requestId='share-message-00001',auth=true)=>f.posts.fetch(new Request('https://test/v1/messages/'+bob,{method:'POST',headers:{...(auth?headers:{}),'Content-Type':'application/json'},body:JSON.stringify({body:'',requestId,application})}));
  let response=await send();assert.equal(response.status,201);const first=await response.json();assert.deepEqual(first.message.application.params,selection.params);assert.equal(first.message.application.author.id,bob);
  response=await send();assert.equal(response.status,200);assert.equal((await response.json()).message.id,first.message.id);assert.equal(await f.postsCtx.storage.get('dm-unread:'+bob),1);
  assert.equal((await send({...selection,params:{level:6}})).status,409);
  assert.equal((await send(selection,'share-message-00002',false)).status,401);
  assert.equal((await send({...selection,appId:'app-private'},'share-message-00003')).status,404);
  const page=await(await f.call('/v1/messages/'+bob,true)).json();assert.deepEqual(page.messages[0].application.params,selection.params);
  // Retries of an already accepted card still work after withdrawal.
  f.env.WORKSHOP.getByName=()=>({fetch:async()=>Response.json({applications:[]})});assert.equal((await send()).status,200);
 }finally{await f.workshopCtx.flush();await f.postsCtx.flush();f.close()}
});
test('public landing page preserves params in Android intent and browser fallback',async()=>{
 const f=fixture();try{
  await f.workshopCtx.storage.put('shared:app-share',market('app-share'));
  const params=encodeURIComponent(JSON.stringify({item:"O'Brien 中文 😺",room:'x&y#z'}));
  const response=await f.call('/applications/app-share?p='+params);assert.equal(response.status,200);const html=await response.text();
  assert.ok(html.includes('intent://applications/app-share?p='));assert.ok(html.includes('browser_fallback_url=https%3A%2F%2Fzijinhua.297782.xyz%2Fapplications%2Fapp-share%3Fp%3D'));
  assert.ok(html.includes('%27'));assert.equal((await f.call('/applications/app-share?p=null')).status,400);assert.equal((await f.call('/applications/app-share?p=%7B%7D&p=%7B%7D')).status,400);
 }finally{await f.workshopCtx.flush();await f.postsCtx.flush();f.close()}
});

test('post friend shares use canonical snapshots and idempotent authenticated sends',async()=>{
 const f=fixture();try{
  const created=await f.posts.fetch(new Request('https://test/v1/posts',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({body:'真实动态',imageIds:[],requestId:'post-create-000001'})}));
  assert.equal(created.status,201);const {post}=await created.json();
  const send=(postId=post.id,requestId='post-message-00001',auth=true)=>f.posts.fetch(new Request('https://test/v1/messages/'+bob,{method:'POST',headers:{...(auth?headers:{}),'Content-Type':'application/json'},body:JSON.stringify({body:'',requestId,postId,post:{body:'伪造'}})}));
  let response=await send();assert.equal(response.status,201);const first=await response.json();assert.equal(first.message.post.body,'真实动态');assert.equal(first.message.post.author.id,alice);
  response=await send();assert.equal(response.status,200);assert.equal((await response.json()).message.id,first.message.id);assert.equal(await f.postsCtx.storage.get('dm-unread:'+bob),1);
  assert.equal((await send('c'.repeat(64))).status,409);assert.equal((await send(post.id,'post-message-00002',false)).status,401);assert.equal((await send('c'.repeat(64),'post-message-00003')).status,404);
  const key=await f.postsCtx.storage.get('id:'+post.id);await f.postsCtx.storage.delete(key);assert.equal((await send()).status,200);assert.equal((await send(post.id,'post-message-00004')).status,404);
 }finally{await f.postsCtx.flush();f.close()}
});
