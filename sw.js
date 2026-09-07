const CACHE='gridledger-mobile-v3-1-history-1';
const STATIC_ASSETS=[
  './styles.css','./app.js','./manifest.webmanifest',
  './icon-192.png','./icon-512.png','./cloud-sync.js','./history-fix.js'
];

async function injectBridges(response){
  const type=response.headers.get('content-type')||'';
  if(!type.includes('text/html')) return response;
  let html=await response.text();
  if(!html.includes('cloud-sync.js')) html=html.replace('</body>','<script src="./cloud-sync.js"></script>\n</body>');
  if(!html.includes('history-fix.js')) html=html.replace('</body>','<script src="./history-fix.js"></script>\n</body>');
  const headers=new Headers(response.headers);
  headers.set('content-type','text/html; charset=utf-8');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
}
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC_ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  if(event.request.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const network=await fetch(event.request,{cache:'no-store'});
        const modified=await injectBridges(network);
        caches.open(CACHE).then(c=>c.put('./index.html',modified.clone()));
        return modified;
      }catch{
        const cached=await caches.match('./index.html');
        if(cached)return cached;
        const fallback=await caches.match('./');
        if(fallback)return injectBridges(fallback);
        throw new Error('GridLedger indisponible hors ligne avant la première ouverture.');
      }
    })()); return;
  }
  event.respondWith((async()=>{
    try{
      const response=await fetch(event.request,{cache:'no-store'});
      if(response.ok)caches.open(CACHE).then(c=>c.put(event.request,response.clone()));
      return response;
    }catch{return (await caches.match(event.request))||Response.error()}
  })());
});