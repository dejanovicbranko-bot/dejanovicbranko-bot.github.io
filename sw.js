const CACHE='gridledger-mobile-v4-cockpit-2';
const STATIC_ASSETS=[
 './styles.css','./app.js','./manifest.webmanifest','./icon-192.png','./icon-512.png',
 './cloud-sync.js','./history-fix.js','./ui-v32.js','./gridledger-v4.js'
];
async function inject(response){
 const type=response.headers.get('content-type')||'';
 if(!type.includes('text/html'))return response;
 let html=await response.text();
 for(const f of ['cloud-sync.js','history-fix.js','ui-v32.js','gridledger-v4.js']){
   if(!html.includes(f))html=html.replace('</body>',`<script src="./${f}"></script>\n</body>`);
 }
 const h=new Headers(response.headers);h.set('content-type','text/html; charset=utf-8');
 return new Response(html,{status:response.status,statusText:response.statusText,headers:h});
}
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC_ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 if(e.request.mode==='navigate'){e.respondWith((async()=>{try{const r=await fetch(e.request,{cache:'no-store'});const m=await inject(r);caches.open(CACHE).then(c=>c.put('./index.html',m.clone()));return m}catch{const c=await caches.match('./index.html')||await caches.match('./');if(c)return inject(c);throw new Error('GridLedger indisponible hors ligne')}})());return}
 e.respondWith((async()=>{try{const r=await fetch(e.request,{cache:'no-store'});if(r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r}catch{return await caches.match(e.request)||Response.error()}})());
});