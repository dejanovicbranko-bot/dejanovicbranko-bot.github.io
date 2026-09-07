
const CFG_KEY='gridledger_personnel_secure_cfg_v2_1';
const DB_NAME='gridledger_personnel_secure_v2_1';
const DB_VERSION=1;
const STATE_ID='state';
const DEFAULT_ITERATIONS=310000;
const APP_VERSION='2.2';

let vaultKey=null;
let currentState=null;
let deferredInstallPrompt=null;
let selectedBotId=null;
let temporaryDemoSnapshot=null;
let inactivityTimer=null;
let currentCaptureData=null;
let currentCaptureFile=null;
let captureParsed=null;
let captureOCRConfidence=null;
let tesseractWorker=null;
let pointerFieldKey=null;

const $=id=>document.getElementById(id);

function demoState(){
  return {
    version:2,
    reportingCurrency:'EUR',
    settings:{autoLockMinutes:5},
    locations:[],
    bots:[],
    movements:[],
    snapshots:[],
    observations:[],
    auditEvents:[],
    strategyEpochs:[],
    goals:{wealth:0,protected:0,botMaxPct:0,note:''},
    planning:{},
    taxScenarios:{},
    fiscal:{country:'MANUAL'},
    updated:new Date().toISOString().slice(0,10)
  };
}

function ensureStateShape(s){
  s.version=2;
  s.settings=s.settings||{};
  if(!s.settings.autoLockMinutes)s.settings.autoLockMinutes=5;
  s.settings.aiBridge=s.settings.aiBridge||{mode:'LOCAL_SHARE',automaticWrites:false};
  s.locations=Array.isArray(s.locations)?s.locations:[];
  s.bots=Array.isArray(s.bots)?s.bots:[];
  s.movements=Array.isArray(s.movements)?s.movements:[];
  s.snapshots=Array.isArray(s.snapshots)?s.snapshots:[];
  s.observations=Array.isArray(s.observations)?s.observations:[];
  s.auditEvents=Array.isArray(s.auditEvents)?s.auditEvents:[];
  s.strategyEpochs=Array.isArray(s.strategyEpochs)?s.strategyEpochs:[];
  s.goals=s.goals||{wealth:0,protected:0,botMaxPct:0,note:''};
  s.planning=s.planning||{};
  s.taxScenarios=s.taxScenarios||{};
  s.fiscal=s.fiscal||{country:'MANUAL'};

  // v2.1.1 : l'immobilier personnel est hors périmètre GridLedger.
  // Migration ciblée de l'ancien import v2.1 uniquement.
  if(!s.settings.realEstateExcludedMigrationDone){
    const hadImportedRealEstate=s.locations.some(l=>l.id==='home-taviers-net');
    if(hadImportedRealEstate){
      s.locations=s.locations.filter(l=>l.id!=='home-taviers-net');
      s.observations=s.observations.filter(o=>o.locationId!=='home-taviers-net');
      s.auditEvents.push({
        id:uid(),
        type:'REAL_ESTATE_EXCLUDED_FROM_GRIDLEDGER',
        createdAt:nowIso(),
        note:'Immobilier retiré du capital financier suivi.'
      });
    }
    s.settings.realEstateExcludedMigrationDone=true;
  }

  for(const l of s.locations){
    if(!l.class)l.class='MOBILISABLE';
    if(l.baseline===undefined)l.baseline=0;
    if(l.balance===undefined)l.balance=0;
  }
  for(const b of s.bots){
    if(!b.status)b.status='ACTIVE';
    if(b.baseline===undefined)b.baseline=0;
    if(b.value===undefined)b.value=0;
  }
  return s;
}
function money(v){return Number(v||0).toLocaleString('fr-BE',{style:'currency',currency:'EUR'})}

function nowIso(){return new Date().toISOString()}
function snapshotMoment(s){
  return s.capturedAt||s.createdAt||null;
}
function snapshotDateForRange(s){
  return snapshotMoment(s)||(s.date?`${s.date}T12:00:00`:null);
}
function sameSnapshotMetrics(a,b){
  return String(a.botId||'')===String(b.botId||'') &&
    String(a.date||'')===String(b.date||'') &&
    Number(a.gridProfitNative ?? a.gridProfit ?? a.grid ?? NaN)===Number(b.gridProfitNative ?? b.gridProfit ?? b.grid ?? NaN) &&
    Number(a.latentNative ?? a.latent ?? NaN)===Number(b.latentNative ?? b.latent ?? NaN) &&
    String(a.nativeUnit||a.unit||'').toUpperCase()===String(b.nativeUnit||b.unit||'').toUpperCase();
}
function uid(){return crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random()}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function total(s){return s.locations.reduce((a,l)=>a+Number(l.balance||0),0)}
function baseline(s){return s.locations.reduce((a,l)=>a+Number(l.baseline||0),0)}
function contributions(s){return s.movements.filter(m=>m.type==='CONTRIBUTION').reduce((a,m)=>a+Number(m.value||0),0)}
function distributions(s){return s.movements.filter(m=>m.type==='DISTRIBUTION').reduce((a,m)=>a+Number(m.value||0),0)}
function performance(s){return total(s)+distributions(s)-contributions(s)-baseline(s)}
function botOpeningBaseline(b,s){
  if(b.baseline!==undefined&&b.baseline!==null)return Number(b.baseline||0);
  const loc=(s.locations||[]).find(l=>l.id===b.locationId);
  return Number(loc?.baseline||0);
}
function botAccounting(b,s){
  const loc=b.locationId;
  const moves=(s.movements||[]);

  const internalIn=moves
    .filter(m=>m.type==='TRANSFER'&&m.to===loc)
    .reduce((a,m)=>a+Number(m.value||0),0);

  const internalOut=moves
    .filter(m=>m.type==='TRANSFER'&&m.from===loc)
    .reduce((a,m)=>a+Number(m.value||0),0);

  const externalIn=moves
    .filter(m=>m.type==='CONTRIBUTION'&&(m.locationId===loc||m.to===loc))
    .reduce((a,m)=>a+Number(m.value||0),0);

  const externalOut=moves
    .filter(m=>m.type==='DISTRIBUTION'&&(m.locationId===loc||m.from===loc))
    .reduce((a,m)=>a+Number(m.value||0),0);

  const feeMoves=moves
    .filter(m=>m.type==='FEE'&&(m.locationId===loc||m.from===loc||m.botId===b.id));

  const fees=feeMoves.reduce((a,m)=>a+Number(m.value||0),0);

  // Only costs paid outside the observed bot value are subtracted separately.
  // Every other fee treatment is explanatory to avoid double counting.
  const externalFeeCost=feeMoves
    .filter(m=>m.feeTreatment==='EXTERNAL_ACCRUAL')
    .reduce((a,m)=>a+Number(m.value||0),0);

  const unknownFees=feeMoves
    .filter(m=>!m.feeTreatment||m.feeTreatment==='UNKNOWN')
    .reduce((a,m)=>a+Number(m.value||0),0);

  const financing=internalIn+externalIn;
  const recoveredOut=internalOut+externalOut;
  const opening=botOpeningBaseline(b,s);
  const current=Number(b.value||0);

  const performance=current+recoveredOut-financing-opening-externalFeeCost;

  const withdrawnGain=moves
    .filter(m=>m.type==='TRANSFER'&&m.from===loc&&m.botRole==='WITHDRAWN_GAIN')
    .reduce((a,m)=>a+Number(m.value||0),0);

  const reinvestment=moves
    .filter(m=>m.type==='TRANSFER'&&m.to===loc&&m.botRole==='REINVESTMENT')
    .reduce((a,m)=>a+Number(m.value||0),0);

  return {
    current,opening,internalIn,internalOut,externalIn,externalOut,
    financing,recoveredOut,fees,externalFeeCost,unknownFees,
    performance,withdrawnGain,reinvestment
  };
}
function botPerf(b,s){return botAccounting(b,s).performance}
function portfolioFlowSummary(s){
  const moves=s.movements||[];
  const feeMoves=moves.filter(m=>m.type==='FEE');
  return {
    opening:baseline(s),
    contributions:contributions(s),
    distributions:distributions(s),
    internalTransfers:moves.filter(m=>m.type==='TRANSFER').reduce((a,m)=>a+Math.abs(Number(m.value||0)),0),
    fees:feeMoves.reduce((a,m)=>a+Math.abs(Number(m.value||0)),0),
    externalAccrualFees:feeMoves.filter(m=>m.feeTreatment==='EXTERNAL_ACCRUAL').reduce((a,m)=>a+Math.abs(Number(m.value||0)),0)
  };
}
function dateOnlyLabel(v){
  if(!v)return 'Jamais';
  try{return new Date(v.length===10?v+'T12:00:00':v).toLocaleDateString('fr-BE')}catch{return String(v)}
}
function daysSince(v){
  if(!v)return null;
  const d=new Date(v.length===10?v+'T12:00:00':v);
  if(Number.isNaN(d.getTime()))return null;
  return Math.max(0,Math.floor((Date.now()-d.getTime())/86400000));
}
function freshnessLabel(v){
  const d=daysSince(v);
  if(d===null)return {label:'Jamais mis à jour',cls:'freshBad'};
  if(d<=7)return {label:d===0?'Aujourd’hui':`${d} j`,cls:'freshGood'};
  if(d<=30)return {label:`${d} j`,cls:'freshWarn'};
  return {label:`${d} j`,cls:'freshBad'};
}
function latestObservationMomentForLocation(s,loc){
  const moments=(s.observations||[]).filter(o=>o.locationId===loc.id).map(o=>o.observedAt||o.date).filter(Boolean).sort();
  return moments[moments.length-1]||loc.lastObservedAt||null;
}
function latestSnapshotForBot(s,b){
  const snaps=(s.snapshots||[]).filter(x=>x.botId===b.id).slice().sort((a,z)=>String(snapshotDateForRange(a)||'').localeCompare(String(snapshotDateForRange(z)||'')));
  return snaps[snaps.length-1]||null;
}
function recentActivityItems(s,limit=6){
  const out=[];
  for(const m of s.movements||[]){
    const route=(()=>{
      const from=(s.locations||[]).find(l=>l.id===m.from)?.name;
      const to=(s.locations||[]).find(l=>l.id===m.to)?.name;
      if(m.type==='CONTRIBUTION')return `Extérieur → ${to||'capital financier'}`;
      if(m.type==='DISTRIBUTION')return `${from||'capital financier'} → extérieur`;
      if(m.type==='TRANSFER')return `${from||'—'} → ${to||'—'}`;
      return (s.locations||[]).find(l=>l.id===m.locationId)?.name||'Capital financier';
    })();
    out.push({moment:m.createdAt||m.date||'',title:movementTypeLabel(m.type),detail:`${route} · ${money(m.value)}`});
  }
  for(const sn of s.snapshots||[]){
    const b=(s.bots||[]).find(x=>x.id===sn.botId);
    out.push({moment:sn.capturedAt||sn.date||'',title:'Snapshot bot',detail:`${b?.name||'Bot'} · ${sn.nativeUnit||sn.unit||'unité native'}`});
  }
  for(const o of s.observations||[]){
    const l=(s.locations||[]).find(x=>x.id===o.locationId);
    if(o.sourceType==='BASE_WORKBOOK')continue;
    out.push({moment:o.observedAt||o.date||'',title:'Valeur observée',detail:`${l?.name||'Actif'} · ${money(o.value)}`});
  }
  return out.sort((a,b)=>String(b.moment).localeCompare(String(a.moment))).slice(0,limit);
}
function buildAssistantContext(s){
  const flow=portfolioFlowSummary(s);
  return {
    schema:'gridledger-context-v1',
    appVersion:APP_VERSION,
    generatedAt:nowIso(),
    reportingCurrency:s.reportingCurrency||'EUR',
    privacy:{userInitiatedShare:true,rawDocumentsIncluded:false,rawScreenshotsIncluded:false,passwordOrKeysIncluded:false},
    summary:{
      capitalFinancial:total(s),openingValue:flow.opening,economicPerformance:performance(s),
      externalContributions:flow.contributions,externalDistributions:flow.distributions,
      internalTransferVolume:flow.internalTransfers,feesRecorded:flow.fees,externalAccrualFees:flow.externalAccrualFees
    },
    locations:(s.locations||[]).map(l=>({
      id:l.id,name:l.name,type:l.type,class:l.class,currentValueEUR:Number(l.balance||0),openingValueEUR:Number(l.baseline||0),
      lastObservedAt:latestObservationMomentForLocation(s,l),confidence:l.confidence||'CERTAIN'
    })),
    bots:(s.bots||[]).map(b=>{
      const a=botAccounting(b,s),sn=latestSnapshotForBot(s,b),native=b.lastNativeSnapshot||sn;
      return {
        id:b.id,name:b.name,platform:b.platform||'',pair:b.pair||'',status:b.status||'ACTIVE',
        currentValueEUR:Number(b.value||0),openingValueEUR:a.opening,financingReceivedEUR:a.financing,
        withdrawnGainEUR:a.withdrawnGain,reinvestmentEUR:a.reinvestment,feesRecordedEUR:a.fees,
        economicPerformanceEUR:a.performance,lastValueObservedAt:b.valueObservedAt||latestObservationMomentForLocation(s,(s.locations||[]).find(l=>l.id===b.locationId)||{}),
        nativeMetrics:native?{
          date:native.date||sn?.date||null,unit:native.unit||native.nativeUnit||sn?.nativeUnit||null,
          gridProfit:native.grid??native.gridProfitNative??sn?.gridProfitNative??null,
          latentPnL:native.latent??native.latentNative??sn?.latentNative??null,
          withdrawn:native.withdrawn??native.withdrawnNative??sn?.withdrawnNative??null,
          valuationStatus:native.valuationStatus||sn?.valuationStatus||null
        }:null
      };
    }),
    goals:{capitalFinancialEUR:Number(s.goals?.wealth||0),longTermAndReserveEUR:Number(s.goals?.protected||0),botMaxPct:Number(s.goals?.botMaxPct||0)},
    quality:stateQualityChecks(s).map(x=>({check:x.name,status:x.level,detail:x.detail})),
    accountingRules:[
      'Les transferts internes sont neutres globalement.',
      'Grid Profit et P&L latent sont des métriques explicatives natives et ne doivent pas être additionnés à la performance économique.',
      'Aucune écriture ne doit être créée sans validation humaine.'
    ]
  };
}
function assistantPromptAndContext(s){
  const ctx=buildAssistantContext(s);
  return `Contexte GridLedger généré par l’utilisateur. Analyse uniquement les données ci-dessous. Ne donne aucun ordre de trading, ne promets aucun rendement et ne suppose aucune donnée absente. Distingue performance économique, Grid Profit et P&L latent. Propose les vérifications ou mises à jour utiles, mais demande confirmation avant toute écriture comptable.\n\n${JSON.stringify(ctx,null,2)}`;
}
async function copyTextSafe(textValue){
  if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(textValue);return true}
  const ta=document.createElement('textarea');ta.value=textValue;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
  const ok=document.execCommand('copy');ta.remove();return ok;
}
function renderAssistant(){
  if(!currentState)return;
  const preview=$('assistantContextPreview');
  if(preview)preview.value=assistantPromptAndContext(currentState);
  if($('appVersion'))$('appVersion').textContent=APP_VERSION;
}
async function shareAssistantContext(){
  const textValue=assistantPromptAndContext(currentState);
  try{
    if(navigator.share){
      await navigator.share({title:'GridLedger · contexte pour ChatGPT',text:textValue});
      $('assistantShareStatus').textContent='Partage Android ouvert. Les données n’ont été transmises qu’à l’application que tu as choisie.';
      return;
    }
    await copyTextSafe(textValue);
    $('assistantShareStatus').textContent='Partage système indisponible : contexte copié. Colle-le dans ChatGPT.';
  }catch(e){
    if(e?.name!=='AbortError')$('assistantShareStatus').textContent='Partage impossible. Utilise « Copier le contexte ».';
  }
}
async function copyAssistantContext(){
  try{await copyTextSafe(assistantPromptAndContext(currentState));$('assistantShareStatus').textContent='Contexte copié. Tu peux le coller dans ChatGPT.'}
  catch{$('assistantShareStatus').textContent='Copie impossible sur ce navigateur.'}
}
async function shareCaptureToAssistant(){
  if(!currentCaptureFile)return alert('Choisis d’abord une capture.');
  const botHints=(currentState?.bots||[]).map(b=>`${b.id} | ${b.name} | ${b.platform||'plateforme inconnue'} | ${b.pair||'paire inconnue'}`).join('\n');
  const instruction=`Analyse cette capture pour GridLedger. Identifie la plateforme, le bot probable, la paire, la date, la valeur courante, le Grid Profit, le P&L latent, les gains retirés et l’unité. N’invente aucun chiffre. Signale chaque champ incertain. Ne propose aucune transaction. Bots connus:\n${botHints||'Aucun bot connu.'}`;
  try{
    if(navigator.share && (!navigator.canShare || navigator.canShare({files:[currentCaptureFile]}))){
      await navigator.share({title:'Capture GridLedger pour ChatGPT',text:instruction,files:[currentCaptureFile]});
      $('ocrStatus').className='ocrStatus ok';
      $('ocrStatus').textContent='Capture partagée via Android. GridLedger n’a rien enregistré automatiquement.';
      return;
    }
    await copyTextSafe(instruction);
    alert('Le partage de fichier n’est pas disponible ici. L’instruction a été copiée : ouvre ChatGPT et joins la capture manuellement.');
  }catch(e){
    if(e?.name!=='AbortError')alert('Partage impossible sur cet appareil.');
  }
}
function bytesToB64(bytes){
  const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  let s='';const CHUNK=0x8000;
  for(let i=0;i<u8.length;i+=CHUNK)s+=String.fromCharCode(...u8.subarray(i,i+CHUNK));
  return btoa(s);
}
function b64ToBytes(b64){
  const bin=atob(b64),u8=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
  return u8;
}
function randomBytes(n){const a=new Uint8Array(n);crypto.getRandomValues(a);return a}
async function deriveKey(password,saltB64,iterations){
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2',salt:b64ToBytes(saltB64),iterations,hash:'SHA-256'},
    material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']
  );
}
async function encryptBytes(bytes,key=vaultKey){
  const iv=randomBytes(12);
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,bytes);
  return {iv:bytesToB64(iv),data:cipher};
}
async function decryptBytes(record,key=vaultKey){
  return crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(record.iv)},key,record.data);
}
async function encryptJSON(obj,key=vaultKey){
  const bytes=new TextEncoder().encode(JSON.stringify(obj));
  return encryptBytes(bytes,key);
}
async function decryptJSON(record,key=vaultKey){
  const plain=await decryptBytes(record,key);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('records'))db.createObjectStore('records',{keyPath:'id'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function dbPut(record){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readwrite');
    tx.objectStore('records').put(record);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  });
}
async function dbGet(id){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction('records','readonly').objectStore('records').get(id);
    req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);
  });
}
async function dbGetAll(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction('records','readonly').objectStore('records').getAll();
    req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);
  });
}
async function dbDelete(id){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readwrite');tx.objectStore('records').delete(id);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  });
}
async function dbClear(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readwrite');tx.objectStore('records').clear();
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  });
}

function getConfig(){
  try{return JSON.parse(localStorage.getItem(CFG_KEY))}catch{return null}
}
function setConfig(cfg){localStorage.setItem(CFG_KEY,JSON.stringify(cfg))}

async function createVault(){
  const p=$('newPassword').value,c=$('confirmPassword').value;
  if(p.length<6)return alert('Utilise au moins 6 caractères.');
  if(p!==c)return alert('Les deux saisies ne correspondent pas.');
  const salt=bytesToB64(randomBytes(16)),iterations=DEFAULT_ITERATIONS;
  const key=await deriveKey(p,salt,iterations);
  const verifier=await encryptJSON({ok:true,createdAt:new Date().toISOString()},key);
  const cfg={version:1,salt,iterations,verifier:{iv:verifier.iv,data:bytesToB64(verifier.data)}};
  setConfig(cfg);
  vaultKey=key;
  currentState=ensureStateShape(demoState());
  await saveState();
  $('newPassword').value='';$('confirmPassword').value='';
  enterApp();
}
async function unlockVault(){
  $('unlockError').textContent='';
  const cfg=getConfig(),p=$('unlockPassword').value;
  try{
    const key=await deriveKey(p,cfg.salt,cfg.iterations);
    const verifier={iv:cfg.verifier.iv,data:b64ToBytes(cfg.verifier.data).buffer};
    const check=await decryptJSON(verifier,key);
    if(!check.ok)throw new Error('bad');
    vaultKey=key;
    const rec=await dbGet(STATE_ID);
    currentState=ensureStateShape(rec?await decryptJSON(rec):demoState());
    await saveState();
    $('unlockPassword').value='';
    enterApp();
  }catch(e){
    vaultKey=null;currentState=null;
    $('unlockError').textContent='Mot de passe incorrect ou coffre illisible.';
  }
}
function lockVault(){
  vaultKey=null;currentState=null;currentCaptureData=null;
  clearTimeout(inactivityTimer);
  $('app').hidden=true;$('securityGate').style.display='flex';
  $('createVaultPane').hidden=true;$('unlockVaultPane').hidden=false;
  $('unlockPassword').value='';$('unlockError').textContent='';
}
function enterApp(){
  $('securityGate').style.display='none';$('app').hidden=false;
  $('autoLockMinutes').value=String(currentState.settings?.autoLockMinutes||5);
  $('docYear').value=new Date().getFullYear();
  renderAll();
  resetInactivity();
}
function resetInactivity(){
  if(!vaultKey||!currentState)return;
  clearTimeout(inactivityTimer);
  const mins=Number(currentState.settings?.autoLockMinutes||5);
  inactivityTimer=setTimeout(lockVault,mins*60*1000);
}
async function saveState(){
  if(!vaultKey||!currentState)throw new Error('Coffre verrouillé');
  const enc=await encryptJSON(currentState);
  await dbPut({id:STATE_ID,type:'state',iv:enc.iv,data:enc.data});
}
async function mutateState(fn){
  fn(currentState);currentState.updated=new Date().toISOString().slice(0,10);
  await saveState();renderAll();
}

async function saveDocument(){
  const f=$('docFile').files[0];if(!f)return alert('Choisis un fichier.');
  if(f.size>30*1024*1024)return alert('Cette bêta limite un fichier à 30 Mo.');
  const id=uid();
  const meta={
    id,fileName:f.name,title:$('docTitle').value.trim()||f.name,year:Number($('docYear').value)||new Date().getFullYear(),
    category:$('docCategory').value,entity:$('docEntity').value,note:$('docNote').value.trim(),includeTax:$('docTax').checked,
    confidence:'CERTAIN',mime:f.type||'application/octet-stream',size:f.size,createdAt:new Date().toISOString()
  };
  const metaEnc=await encryptJSON(meta);
  const fileEnc=await encryptBytes(await f.arrayBuffer());
  await dbPut({id:'docmeta:'+id,type:'docmeta',iv:metaEnc.iv,data:metaEnc.data});
  await dbPut({id:'docfile:'+id,type:'docfile',iv:fileEnc.iv,data:fileEnc.data});
  $('docFile').value='';$('docTitle').value='';$('docNote').value='';$('docTax').checked=false;
  await renderDocuments();await renderDocCounts();
}
async function getDocMetas(){
  if(!vaultKey)return [];
  const all=await dbGetAll(),out=[];
  for(const r of all.filter(x=>x.type==='docmeta')){
    try{out.push(await decryptJSON(r))}catch{}
  }
  return out;
}
async function openDocument(id){
  const metas=await getDocMetas(),meta=metas.find(x=>x.id===id),rec=await dbGet('docfile:'+id);
  if(!meta||!rec)return;
  try{
    const plain=await decryptBytes(rec);
    const url=URL.createObjectURL(new Blob([plain],{type:meta.mime}));
    window.open(url,'_blank');
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch{alert('Impossible de déchiffrer ce document.')}
}
async function removeDocument(id){
  if(!confirm('Supprimer définitivement ce document du coffre local ?'))return;
  await dbDelete('docmeta:'+id);await dbDelete('docfile:'+id);
  await renderDocuments();await renderFiscal();await renderDocCounts();
}

function nav(screen){
  document.querySelectorAll('.screen').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.bottomNav button').forEach(x=>x.classList.toggle('active',x.dataset.screen===screen));
  $(screen).classList.add('active');
  const names={dashboard:'Tableau de bord',capture:'Capture intelligente',bots:'Bots',botDetail:'Détail du bot',documents:'Documents',fiscal:'Dossier fiscal',settings:'Plus',patrimoine:'Capital financier',history:'Historique',goals:'Objectifs',quality:'Qualité des données',assistant:'Assistant GridLedger'};
  $('pageTitle').textContent=names[screen]||'GridLedger';
  window.scrollTo({top:0,behavior:'instant'});
  if(screen==='documents')renderDocuments();
  if(screen==='fiscal')renderFiscal();
  if(screen==='botDetail')renderBotDetail();
  if(screen==='patrimoine')renderPatrimoine();
  if(screen==='history')renderHistory();
  if(screen==='goals')renderGoals();
  if(screen==='quality')renderQuality();
  if(screen==='settings')renderImportedPlanning();
  if(screen==='assistant')renderAssistant();
}
function renderDashboard(){
  const s=currentState;
  const flow=portfolioFlowSummary(s);
  const botTotal=s.bots.reduce((a,b)=>a+Number(b.value||0),0);
  const protectedTotal=s.locations.filter(l=>l.class==='PROTECTED').reduce((a,l)=>a+Number(l.balance||0),0);
  $('totalValue').textContent=money(total(s));
  $('globalPerf').textContent=money(performance(s));
  $('botValue').textContent=money(botTotal);
  $('protectedValue').textContent=money(protectedTotal);
  if($('contributionValue'))$('contributionValue').textContent=money(flow.contributions);
  if($('distributionValue'))$('distributionValue').textContent=money(flow.distributions);
  $('dashAutoLock').textContent=(s.settings?.autoLockMinutes||5)+' min';

  const assetRows=(s.locations||[]).slice().sort((a,b)=>Number(b.balance||0)-Number(a.balance||0));
  $('dashboardAssets').innerHTML=assetRows.map(l=>{
    const when=latestObservationMomentForLocation(s,l),fresh=freshnessLabel(when);
    const bot=(s.bots||[]).find(b=>b.locationId===l.id);
    return `<div class="dashboardAssetRow">
      <div class="dashboardAssetMain"><b>${escapeHtml(l.name)}</b><span>${escapeHtml(classLabel(l.class))}${bot?` · ${escapeHtml(bot.platform||'bot')}`:''}</span></div>
      <div class="dashboardAssetValue"><b>${money(l.balance)}</b><span class="freshTag ${fresh.cls}">${escapeHtml(fresh.label)}</span></div>
    </div>`;
  }).join('')||'<div class="muted">Aucun actif financier.</div>';

  $('dashboardFlows').innerHTML=`
    <div><span>Valeur d’ouverture</span><b>${money(flow.opening)}</b></div>
    <div><span>Apports extérieurs</span><b>${money(flow.contributions)}</b></div>
    <div><span>Distributions extérieures</span><b>${money(flow.distributions)}</b></div>
    <div><span>Transferts internes · volume</span><b>${money(flow.internalTransfers)}</b></div>
    <div><span>Frais enregistrés</span><b>${money(flow.fees)}</b></div>
    <div><span>Coûts externes séparés</span><b>${money(flow.externalAccrualFees)}</b></div>`;

  $('dashboardBots').innerHTML=s.bots.map(b=>{
    const a=botAccounting(b,s),sn=latestSnapshotForBot(s,b),ns=b.lastNativeSnapshot||sn;
    const when=b.valueObservedAt||latestObservationMomentForLocation(s,(s.locations||[]).find(l=>l.id===b.locationId)||{});
    const fresh=freshnessLabel(when);
    const nativeUnit=ns?.unit||ns?.nativeUnit||'—';
    const grid=ns?.grid??ns?.gridProfitNative;
    const latent=ns?.latent??ns?.latentNative;
    return `<div class="botCard botCardClickable dashboardBotDetailed" data-open-bot="${escapeHtml(b.id)}">
      <div class="dashboardBotTop"><div><h3>${escapeHtml(b.name)}</h3><div class="smallmuted">${escapeHtml(b.platform||'Plateforme non définie')} · ${escapeHtml(b.pair||'Paire non définie')}</div></div><span class="freshTag ${fresh.cls}">${escapeHtml(fresh.label)}</span></div>
      <div class="botDetailMiniGrid">
        <div><span>Valeur actuelle</span><b>${money(b.value)}</b></div>
        <div><span>Performance GridLedger</span><b>${money(a.performance)}</b></div>
        <div><span>Ouverture</span><b>${money(a.opening)}</b></div>
        <div><span>Financement reçu</span><b>${money(a.financing)}</b></div>
        <div><span>Gains retirés</span><b>${money(a.withdrawnGain)}</b></div>
        <div><span>Réinvesti</span><b>${money(a.reinvestment)}</b></div>
        <div><span>Frais</span><b>${money(a.fees)}</b></div>
        <div><span>Dernier relevé</span><b>${sn?.date?escapeHtml(dateOnlyLabel(sn.date)):'Aucun snapshot'}</b></div>
      </div>
      <div class="nativeMetricStrip"><span>Grid Profit · ${escapeHtml(nativeUnit)}</span><b>${grid===null||grid===undefined?'—':formatNative(grid,nativeUnit)}</b><span>P&L latent</span><b>${latent===null||latent===undefined?'—':formatNative(latent,nativeUnit)}</b></div>
      <div class="botCardFooter"><button type="button" data-open-bot-btn="${escapeHtml(b.id)}">Voir le détail</button></div>
    </div>`;
  }).join('')||'<div class="muted">Aucun bot.</div>';
  document.querySelectorAll('#dashboardBots [data-open-bot]').forEach(card=>card.addEventListener('click',e=>{if(e.target.closest('button'))return;openBotDetail(card.dataset.openBot)}));
  document.querySelectorAll('#dashboardBots [data-open-bot-btn]').forEach(btn=>btn.addEventListener('click',()=>openBotDetail(btn.dataset.openBotBtn)));

  const mob=s.locations.filter(l=>l.class==='MOBILISABLE').reduce((a,l)=>a+Number(l.balance||0),0);
  const prot=s.locations.filter(l=>l.class==='PROTECTED').reduce((a,l)=>a+Number(l.balance||0),0);
  const ill=s.locations.filter(l=>l.class==='ILLIQUID').reduce((a,l)=>a+Number(l.balance||0),0);
  const t=mob+prot+ill;
  const pct=x=>t>0?Math.max(0,(x/t)*100):0;
  $('dashboardAllocationBar').innerHTML=
    `<div class="allocMob" style="width:${pct(mob)}%"></div><div class="allocProt" style="width:${pct(prot)}%"></div><div class="allocIll" style="width:${pct(ill)}%"></div>`;
  $('dashboardAllocation').innerHTML=
    `<div><span>Mobilisable</span><b>${money(mob)} · ${pct(mob).toFixed(0)}%</b></div>`
    +`<div><span>Long terme + réserve</span><b>${money(prot)} · ${pct(prot).toFixed(0)}%</b></div>`
    +(ill>0?`<div><span>Illiquide financier</span><b>${money(ill)} · ${pct(ill).toFixed(0)}%</b></div>`:'');

  const target=Number(s.goals?.wealth||0);
  const gp=target>0?Math.min(100,Math.max(0,total(s)/target*100)):0;
  const remaining=target>0?Math.max(0,target-total(s)):0;
  $('dashboardGoalText').textContent=target>0?`${money(total(s))} sur ${money(target)} · ${gp.toFixed(1)} % · reste ${money(remaining)}`:'Aucun objectif de capital financier défini.';
  $('dashboardGoalProgress').style.width=gp+'%';

  const quick=stateQualityChecks(s);
  const alerts=quick.filter(x=>x.level!=='OK').length;
  const stale=s.locations.filter(l=>{const d=daysSince(latestObservationMomentForLocation(s,l));return d===null||d>30}).length;
  $('dashboardQuality').textContent=alerts||stale?`${alerts} contrôle(s) à surveiller${stale?` · ${stale} valeur(s) ancienne(s)`:''}.`:'Données cohérentes et valeurs récentes.';

  const recent=recentActivityItems(s);
  $('dashboardRecentActivity').innerHTML=recent.map(x=>`<div class="recentRow"><div><b>${escapeHtml(x.title)}</b><span>${escapeHtml(x.detail)}</span></div><time>${escapeHtml(dateOnlyLabel(x.moment))}</time></div>`).join('')||'<div class="muted">Aucune activité récente après la situation d’ouverture.</div>';
  if($('dashboardAssistantStatus'))$('dashboardAssistantStatus').textContent='Pont local ChatGPT prêt · partage uniquement sur ton action.';
}
async function renderDocCounts(){
  const docs=await getDocMetas(),tax=docs.filter(d=>d.includeTax);
  $('docCount').textContent=docs.length;
  $('taxDocCount').textContent=tax.length+' pièce'+(tax.length>1?'s':'');
  $('dashboardFiscal').textContent=tax.length?`${tax.length} pièce(s) déjà classée(s) pour le dossier fiscal.`:'Aucune pièce fiscale.';
}
function renderBots(){
  const s=currentState;
  $('botsList').innerHTML=s.bots.map(b=>{
    const ns=b.lastNativeSnapshot;
    return `<div class="botCard botCardClickable" data-open-bot="${b.id}">
      <h3>${escapeHtml(b.name)}${ns&&ns.valuationStatus==='PARTIAL_NATIVE'?'<span class="partialTag">snapshot partiel</span>':''}</h3>
      <div class="rows">
        <div><span>Plateforme</span><b>${escapeHtml(b.platform||'—')}</b></div>
        <div><span>Paire</span><b>${escapeHtml(b.pair||'—')}</b></div>
        <div><span>Valeur patrimoniale EUR</span><b>${money(b.value)}</b></div>
        ${ns?`<div><span>Dernière capture native</span><b>${ns.date} · ${escapeHtml(ns.unit||'—')}</b></div>
        <div><span>Source capture</span><b>${escapeHtml(ns.sourceApp||b.platform||'—')}</b></div>
        <div><span>Grid Profit natif</span><b>${formatNative(ns.grid,ns.unit)}</b></div>
        <div><span>P&L latent natif</span><b>${formatNative(ns.latent,ns.unit)}</b></div>`:''}
      </div>
      <div class="botCardFooter"><button type="button" data-open-bot-btn="${b.id}">Voir le détail</button></div>
    </div>`;
  }).join('')||'<div class="muted">Aucun bot.</div>';

  document.querySelectorAll('[data-open-bot]').forEach(card=>{
    card.addEventListener('click',e=>{
      if(e.target.closest('button'))return;
      openBotDetail(card.dataset.openBot);
    });
  });
  document.querySelectorAll('[data-open-bot-btn]').forEach(btn=>{
    btn.addEventListener('click',()=>openBotDetail(btn.dataset.openBotBtn));
  });
}


function nextDateAfter(dateStr){
  const d=dateStr?new Date(dateStr+'T12:00:00'):new Date();
  d.setDate(d.getDate()+1);
  return d.toISOString().slice(0,10);
}
function buildTemporaryDemoSnapshot(botId,baseSnaps){
  const last=baseSnaps[baseSnaps.length-1]||null;
  const unit=(last?snapshotUnit(last):'USDT')||'USDT';
  const date=nextDateAfter(last?.date||new Date().toISOString().slice(0,10));

  // Fixed fictitious values: intentionally not derived from user data.
  return {
    id:'TEMP_DEMO_SNAPSHOT',
    botId,
    date,
    capturedAt:date+'T12:00:00',
    nativeUnit:unit,
    gridProfitNative:25.00,
    latentNative:-5.00,
    nativeValue:null,
    sourceType:'DEMO',
    sourceApp:'GridLedger',
    confidence:'CERTAIN',
    valuationStatus:'PARTIAL_NATIVE',
    isTemporaryDemo:true
  };
}
function toggleTemporaryDemoSnapshot(){
  if(!selectedBotId)return;
  if(temporaryDemoSnapshot){
    temporaryDemoSnapshot=null;
    $('toggleDemoSnapshot').textContent='Ajouter un relevé fictif de test';
    $('demoSnapshotStatus').textContent='Aucune donnée fictive active.';
  }else{
    const real=botSnapshots(selectedBotId);
    temporaryDemoSnapshot=buildTemporaryDemoSnapshot(selectedBotId,real);
    $('toggleDemoSnapshot').textContent='Retirer le relevé fictif';
    $('demoSnapshotStatus').textContent='Test temporaire actif · non enregistré.';
  }
  renderBotDetail();
}
function openBotDetail(botId){
  selectedBotId=botId;
  nav('botDetail');
}
function botSnapshots(botId){
  return (currentState.snapshots||[])
    .filter(s=>s.botId===botId)
    .slice()
    .sort((a,b)=>String(snapshotMoment(a)||a.date||'').localeCompare(String(snapshotMoment(b)||b.date||'')));
}
function collapseChartSnapshots(snaps){
  const groups=new Map();
  for(const s of snaps){
    const key=[
      s.date||'',
      snapshotUnit(s),
      snapshotGrid(s),
      snapshotLatent(s)
    ].join('|');
    if(!groups.has(key))groups.set(key,{snapshot:s,count:1});
    else groups.get(key).count++;
  }
  return [...groups.values()];
}
function snapshotUnit(s){
  return String(s.nativeUnit||s.unit||'').toUpperCase();
}
function snapshotGrid(s){
  const v=s.gridProfitNative ?? s.gridProfit ?? s.grid;
  return v===null||v===undefined?null:Number(v);
}
function snapshotLatent(s){
  const v=s.latentNative ?? s.latent;
  return v===null||v===undefined?null:Number(v);
}
function snapshotNativeValue(s){
  const v=s.nativeValue ?? (s.valuationStatus==='VALUED_EUR'?s.value:null);
  return v===null||v===undefined?null:Number(v);
}
function filterSnapshotsByRange(snaps,range){
  if(range==='ALL')return snaps;
  const days=Number(range);
  if(!days||!snaps.length)return snaps;
  const latest=new Date(snapshotDateForRange(snaps[snaps.length-1])||Date.now());
  const min=new Date(latest.getTime()-days*86400000);
  return snaps.filter(s=>new Date(snapshotDateForRange(s)||0)>=min);
}
function botMovements(bot){
  const loc=bot.locationId;
  return (currentState.movements||[])
    .filter(m=>m.to===loc||m.from===loc||m.locationId===loc||m.botId===bot.id)
    .slice()
    .sort((a,b)=>String(b.date||b.createdAt||'').localeCompare(String(a.date||a.createdAt||'')));
}

function feeTreatmentLabel(value){
  return {
    REFLECTED_IN_VALUE:'Déjà dans la valeur',
    EXTERNAL_ACCRUAL:'Hors valeur',
    TRANSFER_GAP:'Écart de transfert',
    INCLUDED_IN_PLATFORM_METRIC:'Dans métrique plateforme',
    UNKNOWN:'À vérifier'
  }[value]||'À vérifier';
}
function feeTreatmentHelp(value){
  return {
    REFLECTED_IN_VALUE:'Le coût doit déjà se retrouver dans une valeur du bot observée après le frais. GridLedger ne le soustrait pas une deuxième fois.',
    EXTERNAL_ACCRUAL:'Le coût a été payé ailleurs et n’est pas contenu dans la valeur du bot. GridLedger le soustrait séparément de la performance.',
    TRANSFER_GAP:'La perte est déjà visible dans la différence entre montant envoyé et montant reçu. Le frais reste explicatif.',
    INCLUDED_IN_PLATFORM_METRIC:'Le frais est déjà intégré à une métrique de plateforme. Il n’est pas utilisé comme correction supplémentaire de performance.',
    UNKNOWN:'Traitement incertain. GridLedger conserve le frais mais ne le soustrait pas séparément tant qu’il n’est pas qualifié.'
  }[value]||'';
}
function movementRequiresValueRefresh(m){
  if(m.type==='FEE'){
    // External costs are outside the bot value; transfer-gap/platform-metric fees are explanatory.
    // A reflected/unknown fee requires a fresh value observation to ensure chronology is coherent.
    return m.feeTreatment==='REFLECTED_IN_VALUE' || !m.feeTreatment || m.feeTreatment==='UNKNOWN';
  }
  return ['TRANSFER','CONTRIBUTION','DISTRIBUTION'].includes(m.type);
}
function movementRoleLabel(role){
  return {
    FINANCING:'Financement',
    REINVESTMENT:'Réinvestissement',
    WITHDRAWN_GAIN:'Gain retiré',
    CAPITAL_RETURN:'Retour de capital',
    INTERNAL_OTHER:'Transfert interne'
  }[role]||'';
}
function movementLabel(m,bot){
  if(m.type==='TRANSFER'){
    if(m.to===bot.locationId){
      if(m.botRole==='REINVESTMENT')return 'Réinvestissement vers le bot';
      return 'Transfert vers le bot';
    }
    if(m.from===bot.locationId){
      if(m.botRole==='WITHDRAWN_GAIN')return 'Gain retiré du bot';
      if(m.botRole==='CAPITAL_RETURN')return 'Retour de capital';
      return 'Transfert hors du bot';
    }
    return 'Transfert';
  }
  if(m.type==='CONTRIBUTION')return 'Apport extérieur';
  if(m.type==='DISTRIBUTION')return 'Distribution extérieure';
  if(m.type==='FEE')return 'Frais';
  return m.type||'Mouvement';
}
function movementAmount(m){
  const v=m.value ?? m.amount ?? null;
  return v===null||v===undefined?'—':money(v);
}

function latestPlatformWithdrawn(botId){
  const snaps=botSnapshots(botId).slice().reverse();
  const s=snaps.find(x=>(x.withdrawnNative!==null&&x.withdrawnNative!==undefined));
  if(!s)return {value:null,unit:''};
  return {value:Number(s.withdrawnNative),unit:snapshotUnit(s)};
}

function latestBotMovementMoment(bot){
  const moments=botMovements(bot)
    .filter(movementRequiresValueRefresh)
    .map(m=>m.createdAt||(m.date?`${m.date}T23:59:59`:null))
    .filter(Boolean)
    .sort((a,b)=>String(a).localeCompare(String(b)));
  return moments.length?moments[moments.length-1]:null;
}
function botValueObservationMoment(bot){
  return bot.valueObservedAt||null;
}
function botNeedsReconciliation(bot){
  const latestMove=latestBotMovementMoment(bot);
  if(!latestMove)return false;

  const observed=botValueObservationMoment(bot);
  if(!observed)return true;

  return new Date(latestMove).getTime()>new Date(observed).getTime();
}
function formatObservationDateTime(iso){
  if(!iso)return 'inconnue';
  try{
    return new Date(iso).toLocaleString('fr-BE',{
      day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'
    });
  }catch{return 'inconnue'}
}
async function saveBotObservedValue(){
  if(!selectedBotId)return;
  const bot=currentState.bots.find(b=>b.id===selectedBotId);
  if(!bot)return;

  const value=parseLocalizedNumber($('botObservedValue').value);
  if(value===null||value<0)return alert('Saisis une valeur EUR valide.');

  const date=$('botObservedDate').value||new Date().toISOString().slice(0,10);
  const now=new Date();
  const localTime=now.toTimeString().slice(0,8);
  const observedAt=`${date}T${localTime}`;

  bot.value=value;
  bot.valueObservedAt=observedAt;
  bot.valueSource='MANUAL_OBSERVATION';

  currentState.auditEvents=currentState.auditEvents||[];
  currentState.auditEvents.push({
    id:uid(),
    type:'BOT_VALUE_OBSERVED',
    botId:bot.id,
    value,
    observedAt,
    createdAt:nowIso()
  });

  await saveState();
  $('botObservedValue').value='';
  await renderBotDetail();
}
function renderBotAccounting(bot){
  const a=botAccounting(bot,currentState);
  const pending=botNeedsReconciliation(bot);

  const perf=$('botAccountingPerf');
  perf.textContent=money(a.performance);
  perf.classList.remove('accountingPositive','accountingNegative');
  if(!pending){
    if(a.performance>0)perf.classList.add('accountingPositive');
    if(a.performance<0)perf.classList.add('accountingNegative');
  }

  const primary=perf.closest('.primaryKpi');
  primary?.classList.toggle('pending',pending);

  const perfStatus=$('botAccountingPerfStatus');
  perfStatus.textContent=pending?'PROVISOIRE · À RÉCONCILIER':'VALEUR RÉCONCILIÉE';

  const banner=$('botReconcileBanner');
  if(pending){
    banner.hidden=false;
    banner.classList.remove('ok');
    banner.innerHTML=`Un mouvement lié au bot est plus récent que la dernière valeur EUR confirmée. La performance affichée est <b>provisoire</b> jusqu’à une nouvelle observation de valeur.`;
  }else{
    banner.hidden=false;
    banner.classList.add('ok');
    banner.innerHTML=bot.valueObservedAt
      ?`Valeur EUR confirmée le ${escapeHtml(formatObservationDateTime(bot.valueObservedAt))}.`
      :`Aucun mouvement plus récent ne nécessite de réconciliation.`;
  }

  $('botAccountingBaseline').textContent=money(a.opening);
  $('botAccountingIn').textContent=money(a.financing);
  $('botAccountingOut').textContent=money(a.recoveredOut);
  $('botWithdrawnConfirmed').textContent=money(a.withdrawnGain);
  $('botReinvestConfirmed').textContent=money(a.reinvestment);
  $('botFeesRecorded').textContent=money(a.fees);
  $('botFeesBreakdown').innerHTML=
    `dont ${money(a.externalFeeCost)} soustraits hors valeur`
    +(a.unknownFees>0?`<br><span class="accountingNegative">${money(a.unknownFees)} à qualifier</span>`:'');

  const p=latestPlatformWithdrawn(bot.id);
  $('botPlatformWithdrawn').textContent=p.value===null?'—':formatNative(p.value,p.unit);

  $('botAccountingFormula').innerHTML=
    `<b>${money(a.current)}</b> valeur actuelle`
    +` + <b>${money(a.recoveredOut)}</b> sorties`
    +` − <b>${money(a.financing)}</b> financement reçu`
    +` − <b>${money(a.opening)}</b> ouverture`
    +(a.externalFeeCost>0?` − <b>${money(a.externalFeeCost)}</b> frais payés hors valeur`:'')
    +` = <b>${money(a.performance)}</b>`
    +(pending?` <span class="movementRoleTag">provisoire</span>`:'')
    +`.<br><span class="smallmuted">Les réinvestissements sont inclus dans le financement reçu. Les frais déjà reflétés ailleurs restent explicatifs afin d’éviter tout double comptage.</span>`;

  $('botObservedValue').value='';
  if(!$('botObservedDate').value)$('botObservedDate').value=new Date().toISOString().slice(0,10);
}

function renderBotFeeEntry(){
  if(!$('botFeeDate').value)$('botFeeDate').value=new Date().toISOString().slice(0,10);
  updateBotFeeHelp();
}
function updateBotFeeHelp(){
  $('botFeeHelp').textContent=feeTreatmentHelp($('botFeeTreatment').value);
}
async function saveBotFee(){
  if(!selectedBotId)return;
  const bot=currentState.bots.find(b=>b.id===selectedBotId);
  if(!bot)return;

  const amount=parseLocalizedNumber($('botFeeAmount').value);
  if(amount===null||amount<=0)return alert('Saisis un montant EUR supérieur à zéro.');

  const treatment=$('botFeeTreatment').value||'UNKNOWN';
  const date=$('botFeeDate').value||new Date().toISOString().slice(0,10);

  const movement={
    id:uid(),
    type:'FEE',
    value:amount,
    date,
    createdAt:nowIso(),
    sourceType:'MANUAL',
    confidence:treatment==='UNKNOWN'?'TO_VERIFY':'CERTAIN',
    botId:bot.id,
    locationId:bot.locationId,
    feeTreatment:treatment,
    note:$('botFeeNote').value.trim()
  };

  currentState.movements=currentState.movements||[];
  currentState.movements.push(movement);
  await saveState();

  $('botFeeAmount').value='';
  $('botFeeNote').value='';
  await renderBotDetail();
}
function renderBotMovementEntry(bot){
  const select=$('botMoveCounterparty');
  const options=(currentState.locations||[])
    .filter(l=>l.id!==bot.locationId)
    .map(l=>`<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`)
    .join('');
  select.innerHTML=options||'<option value="">Aucun autre emplacement</option>';
  if(!$('botMoveDate').value)$('botMoveDate').value=new Date().toISOString().slice(0,10);
  updateBotMoveRoleOptions();
}
function updateBotMoveRoleOptions(){
  const dir=$('botMoveDirection').value;
  const role=$('botMoveRole');
  if(dir==='IN'){
    role.innerHTML=`
      <option value="FINANCING">Financement du bot</option>
      <option value="REINVESTMENT">Réinvestissement de gains</option>`;
  }else{
    role.innerHTML=`
      <option value="WITHDRAWN_GAIN">Gain retiré</option>
      <option value="CAPITAL_RETURN">Retour de capital</option>
      <option value="INTERNAL_OTHER">Autre transfert interne</option>`;
  }
}
async function saveBotMovement(){
  if(!selectedBotId)return;
  const bot=currentState.bots.find(b=>b.id===selectedBotId);
  if(!bot)return;

  const amount=parseLocalizedNumber($('botMoveAmount').value);
  if(amount===null||amount<=0)return alert('Saisis un montant EUR supérieur à zéro.');

  const counterparty=$('botMoveCounterparty').value;
  if(!counterparty)return alert('Choisis le compte ou emplacement en face.');

  const dir=$('botMoveDirection').value;
  const role=$('botMoveRole').value;
  const date=$('botMoveDate').value||new Date().toISOString().slice(0,10);

  const movement={
    id:uid(),
    type:'TRANSFER',
    value:amount,
    date,
    createdAt:nowIso(),
    sourceType:'MANUAL',
    confidence:'CERTAIN',
    botId:bot.id,
    botRole:role,
    note:$('botMoveNote').value.trim()
  };

  if(dir==='IN'){
    movement.from=counterparty;
    movement.to=bot.locationId;
  }else{
    movement.from=bot.locationId;
    movement.to=counterparty;
  }

  currentState.movements=currentState.movements||[];
  currentState.movements.push(movement);
  await saveState();

  $('botMoveAmount').value='';
  $('botMoveNote').value='';
  await renderBotDetail();
}
async function renderBotDetail(){
  if(!selectedBotId)return nav('bots');
  const bot=currentState.bots.find(b=>b.id===selectedBotId);
  if(!bot)return nav('bots');

  const realSnaps=botSnapshots(bot.id);
  const snaps=temporaryDemoSnapshot&&temporaryDemoSnapshot.botId===bot.id
    ? [...realSnaps,temporaryDemoSnapshot]
    : realSnaps;
  const lastReal=realSnaps[realSnaps.length-1]||null;
  const unit=lastReal?snapshotUnit(lastReal):(bot.lastNativeSnapshot?.unit||'');
  const lastGrid=lastReal?snapshotGrid(lastReal):(bot.lastNativeSnapshot?.grid??null);
  const lastLatent=lastReal?snapshotLatent(lastReal):(bot.lastNativeSnapshot?.latent??null);

  $('botDetailName').textContent=bot.name||'Bot';
  $('botDetailPlatform').textContent=bot.platform||lastReal?.sourceApp||'Plateforme non renseignée';
  $('botDetailPair').textContent=bot.pair||lastReal?.pair||'—';
  $('botDetailEur').textContent=money(bot.value);
  $('botDetailGrid').textContent=formatNative(lastGrid,unit);
  $('botDetailLatent').textContent=formatNative(lastLatent,unit);
  $('botDetailSnapshotCount').textContent=temporaryDemoSnapshot&&temporaryDemoSnapshot.botId===bot.id
    ? `${realSnaps.length} réel + 1 test`
    : String(realSnaps.length);
  $('botDetailStatus').textContent=bot.status||'ACTIVE';

  if(temporaryDemoSnapshot&&temporaryDemoSnapshot.botId===bot.id){
    $('toggleDemoSnapshot').textContent='Retirer le relevé fictif';
    $('demoSnapshotStatus').textContent='Test temporaire actif · non enregistré.';
  }else{
    $('toggleDemoSnapshot').textContent='Ajouter un relevé fictif de test';
    $('demoSnapshotStatus').textContent='Aucune donnée fictive active.';
  }

  renderBotAccounting(bot);
  renderBotMovementEntry(bot);
  renderBotFeeEntry();
  renderBotLifecycle(bot);
  renderBotChart(bot,snaps);
  renderBotSnapshotHistory(snaps);
  renderBotMovementHistory(bot);
  await renderBotLinkedDocs(bot);
}

function snapshotDuplicateKey(s){
  return [
    String(s.botId||''),
    String(s.date||''),
    String(snapshotUnit(s)||''),
    String(snapshotGrid(s)),
    String(snapshotLatent(s)),
    String(snapshotNativeValue(s)),
    String(s.investmentAmountNative ?? ''),
    String(s.currentProfitNative ?? ''),
    String(s.withdrawnNative ?? ''),
    String(s.pair||'')
  ].join('|');
}
function exactSnapshotDuplicateGroups(snaps){
  const groups=new Map();
  for(const s of snaps){
    const key=snapshotDuplicateKey(s);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(s);
  }
  return [...groups.values()].filter(g=>g.length>1);
}
function snapshotConfidenceRank(s){
  if(s.confidence==='CERTAIN')return 3;
  if(s.confidence==='ESTIMATED')return 2;
  return 1;
}
function chooseSnapshotToKeep(group){
  return group.slice().sort((a,b)=>{
    const cr=snapshotConfidenceRank(b)-snapshotConfidenceRank(a);
    if(cr!==0)return cr;
    const adoc=a.documentId?1:0, bdoc=b.documentId?1:0;
    if(bdoc!==adoc)return bdoc-adoc;
    return String(snapshotMoment(a)||a.date||'').localeCompare(String(snapshotMoment(b)||b.date||''));
  })[0];
}
async function mergeExactSnapshotDuplicates(bot,groups){
  if(!groups.length)return;
  const total=groups.reduce((n,g)=>n+(g.length-1),0);
  const ok=confirm(`${total} relevé${total>1?'s':''} strictement identique${total>1?'s':''} détecté${total>1?'s':''}. Conserver un seul relevé par groupe ?`);
  if(!ok)return;

  const removeIds=new Set();
  for(const group of groups){
    const keep=chooseSnapshotToKeep(group);
    const others=group.filter(s=>s.id!==keep.id);

    // Preserve a linked document if the kept snapshot has none.
    if(!keep.documentId){
      const donor=others.find(s=>s.documentId);
      if(donor)keep.documentId=donor.documentId;
    }

    // Preserve best confidence explicitly.
    const best=group.slice().sort((a,b)=>snapshotConfidenceRank(b)-snapshotConfidenceRank(a))[0];
    keep.confidence=best.confidence;

    others.forEach(s=>removeIds.add(s.id));
  }

  currentState.snapshots=(currentState.snapshots||[]).filter(s=>!removeIds.has(s.id));
  await saveState();
  await renderBotDetail();
}
function renderBotSnapshotHistory(snaps){
  const box=$('botSnapshotHistory');
  $('botHistoryCount').textContent=`${snaps.length} relevé${snaps.length>1?'s':''}`;

  const realSnaps=snaps.filter(s=>!s.isTemporaryDemo);
  const duplicateGroups=exactSnapshotDuplicateGroups(realSnaps);
  const duplicateIds=new Set(duplicateGroups.flatMap(g=>g.map(s=>s.id)));
  const notice=$('botSnapshotDuplicateNotice');

  if(duplicateGroups.length){
    const extra=duplicateGroups.reduce((n,g)=>n+(g.length-1),0);
    notice.hidden=false;
    notice.innerHTML=`${extra} relevé${extra>1?'s':''} strictement identique${extra>1?'s':''} détecté${extra>1?'s':''}.<br><button id="mergeExactSnapshotDuplicates">Conserver un seul relevé</button>`;
    setTimeout(()=>{
      const btn=$('mergeExactSnapshotDuplicates');
      if(btn)btn.addEventListener('click',()=>{
        const bot=currentState.bots.find(b=>b.id===selectedBotId);
        if(bot)mergeExactSnapshotDuplicates(bot,duplicateGroups);
      });
    },0);
  }else{
    notice.hidden=true;
    notice.textContent='';
  }

  if(!snaps.length){
    box.innerHTML='<div class="muted">Aucun snapshot enregistré.</div>';
    return;
  }

  const perDay={};
  snaps.forEach(s=>{perDay[s.date]=(perDay[s.date]||0)+1});

  box.innerHTML=snaps.slice().reverse().map(s=>{
    const unit=snapshotUnit(s)||'—';
    const grid=snapshotGrid(s);
    const latent=snapshotLatent(s);
    const val=snapshotNativeValue(s);
    const conf=s.confidence==='CERTAIN'?'Certain':s.confidence==='ESTIMATED'?'Estimé':'À vérifier';
    const moment=snapshotMoment(s);
    let time='heure inconnue';
    if(moment && /T\d{2}:\d{2}/.test(moment)){
      try{time=new Date(moment).toLocaleTimeString('fr-BE',{hour:'2-digit',minute:'2-digit'})}catch{}
    }
    const sameDay=perDay[s.date]||1;
    const duplicate=duplicateIds.has(s.id);
    const demo=!!s.isTemporaryDemo;

    return `<div class="snapshotItem ${duplicate?'snapshotDuplicate':''} ${demo?'demoSnapshotItem':''}">
      <div class="snapshotHead">
        <b>${escapeHtml(s.date||'Sans date')}${sameDay>1?`<span class="sameDayBadge">${sameDay} ce jour</span>`:''}${duplicate?'<span class="snapshotDuplicateTag">doublon exact</span>':''}${demo?'<span class="demoBadge">FICTIF · NON ENREGISTRÉ</span>':''}</b>
        <span>${escapeHtml(s.sourceApp||s.sourceType||'Manuel')} · ${escapeHtml(conf)} · <span class="snapshotTime">${escapeHtml(time)}</span></span>
      </div>
      <div class="snapshotMetrics">
        <div><span>Grid Profit</span><b>${formatNative(grid,unit)}</b></div>
        <div><span>P&L latent</span><b>${formatNative(latent,unit)}</b></div>
        <div><span>Valeur native</span><b>${formatNative(val,unit)}</b></div>
        <div><span>Statut</span><b>${s.valuationStatus==='VALUED_EUR'?'Valorisé EUR':'Natif / partiel'}</b></div>
      </div>
    </div>`;
  }).join('');
}
function renderBotMovementHistory(bot){
  const moves=botMovements(bot);
  const box=$('botMovementHistory');
  if(!moves.length){
    box.innerHTML='<div class="muted">Aucun mouvement lié enregistré.</div>';
    return;
  }
  box.innerHTML=moves.map(m=>{
    const otherId=m.to===bot.locationId?m.from:m.to;
    const other=(currentState.locations||[]).find(l=>l.id===otherId);
    const role=movementRoleLabel(m.botRole);
    const feeTag=m.type==='FEE'?feeTreatmentLabel(m.feeTreatment):'';
    return `<div class="movementItem">
      <div>
        <b>${escapeHtml(movementLabel(m,bot))}${role?`<span class="movementRoleTag">${escapeHtml(role)}</span>`:''}${feeTag?`<span class="feeTreatmentTag">${escapeHtml(feeTag)}</span>`:''}</b>
        <small>${escapeHtml(m.date||m.createdAt?.slice?.(0,10)||'Date non renseignée')}${other?` · ${escapeHtml(other.name)}`:''}${m.note?` · ${escapeHtml(m.note)}`:''}</small>
      </div>
      <b>${movementAmount(m)}</b>
    </div>`;
  }).join('');
}

async function sha256Hex(buffer){
  const digest=await crypto.subtle.digest('SHA-256',buffer);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function linkedDocHashes(docs){
  const out=[];
  for(const d of docs){
    try{
      const rec=await dbGet('docfile:'+d.id);
      if(!rec){out.push({doc:d,hash:null});continue}
      const plain=await decryptBytes(rec);
      const hash=await sha256Hex(plain);
      out.push({doc:d,hash});
    }catch(e){
      out.push({doc:d,hash:null});
    }
  }
  return out;
}
function exactDuplicateGroups(items){
  const groups=new Map();
  for(const item of items){
    if(!item.hash)continue;
    if(!groups.has(item.hash))groups.set(item.hash,[]);
    groups.get(item.hash).push(item.doc);
  }
  return [...groups.values()].filter(g=>g.length>1);
}
async function mergeExactBotDocDuplicates(bot,groups){
  if(!groups.length)return;
  const total=groups.reduce((n,g)=>n+(g.length-1),0);
  const ok=confirm(`${total} copie${total>1?'s':''} strictement identique${total>1?'s':''} détectée${total>1?'s':''}. Conserver une seule copie par groupe ?`);
  if(!ok)return;

  for(const group of groups){
    const keep=group.slice().sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')))[0];
    const duplicates=group.filter(d=>d.id!==keep.id);

    // Repoint snapshot document references before removing encrypted duplicate blobs.
    for(const s of (currentState.snapshots||[])){
      if(duplicates.some(d=>d.id===s.documentId))s.documentId=keep.id;
    }
    for(const d of duplicates){
      await dbDelete('docmeta:'+d.id);
      await dbDelete('docfile:'+d.id);
    }
  }
  await saveState();
  await renderBotLinkedDocs(bot);
}
async function renderBotLinkedDocs(bot){
  const docs=await getDocMetas();
  const linked=docs.filter(d=>d.entity===`BOT:${bot.id}`);
  $('botLinkedDocCount').textContent=`${linked.length} pièce${linked.length>1?'s':''}`;

  const hashed=await linkedDocHashes(linked);
  const groups=exactDuplicateGroups(hashed);
  const duplicateIds=new Set(groups.flatMap(g=>g.map(d=>d.id)));
  const notice=$('botDocDuplicateNotice');

  if(groups.length){
    const extra=groups.reduce((n,g)=>n+(g.length-1),0);
    notice.hidden=false;
    notice.innerHTML=`${extra} copie${extra>1?'s':''} strictement identique${extra>1?'s':''} détectée${extra>1?'s':''} par empreinte SHA-256.<br><button id="mergeExactDuplicates">Conserver une seule copie</button>`;
    setTimeout(()=>{
      const btn=$('mergeExactDuplicates');
      if(btn)btn.addEventListener('click',()=>mergeExactBotDocDuplicates(bot,groups));
    },0);
  }else{
    notice.hidden=true;
    notice.textContent='';
  }

  $('botLinkedDocs').innerHTML=linked.length?linked.map(d=>`<div class="docMini ${duplicateIds.has(d.id)?'docMiniDuplicate':''}">
    <b>${escapeHtml(d.title||d.fileName)}${duplicateIds.has(d.id)?'<span class="duplicateTag">copie exacte</span>':''}</b>
    <div>${escapeHtml(d.category||'Document')} · ${d.year||'—'}${d.includeTax?' · Dossier fiscal':''}</div>
  </div>`).join(''):'<div class="muted">Aucun justificatif lié à ce bot.</div>';
}
function svgEl(name,attrs={}){
  const el=document.createElementNS('http://www.w3.org/2000/svg',name);
  Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,String(v)));
  return el;
}
function renderBotChart(bot,allSnaps){
  const range=$('botChartRange').value||'ALL';
  let snaps=filterSnapshotsByRange(allSnaps,range);

  // Never mix native currencies in one line chart.
  const latestUnit=snaps.length?snapshotUnit(snaps[snaps.length-1]):'';
  const mixedUnits=[...new Set(snaps.map(snapshotUnit).filter(Boolean))];
  if(latestUnit)snaps=snaps.filter(s=>snapshotUnit(s)===latestUnit);

  const collapsed=collapseChartSnapshots(snaps);
  const data=collapsed.map(g=>({
    date:g.snapshot.date,
    moment:snapshotMoment(g.snapshot),
    grid:snapshotGrid(g.snapshot),
    latent:snapshotLatent(g.snapshot),
    duplicates:g.count
  })).filter(d=>d.grid!==null||d.latent!==null);

  const svg=$('botHistoryChart');
  const empty=$('botChartEmpty');
  svg.innerHTML='';

  const unit=latestUnit||bot.lastNativeSnapshot?.unit||'';
  $('botChartSubtitle').textContent=unit?`Grid Profit et P&L latent en ${unit}`:'Métriques natives';
  const collapsedCount=collapsed.reduce((n,g)=>n+Math.max(0,g.count-1),0);
  const hasDemo=allSnaps.some(s=>s.isTemporaryDemo);
  const demoPrefix=hasDemo?'<div class="chartSinglePoint">Mode test : un point fictif temporaire est affiché. Il n’est pas enregistré et ne modifie aucun calcul comptable.</div>':'';
  $('botChartNote').innerHTML=demoPrefix+(mixedUnits.length>1
    ?`Plusieurs unités existent dans l’historique. Le graphique affiche uniquement ${escapeHtml(latestUnit)} pour éviter tout mélange.`
    : data.length===1
      ?`<div class="chartSinglePoint">Un seul point unique est disponible. Le prochain relevé avec des valeurs différentes permettra de tracer une vraie évolution.</div>${collapsedCount>0?`${collapsedCount} snapshot${collapsedCount>1?'s':''} identique${collapsedCount>1?'s':''} regroupé${collapsedCount>1?'s':''}. `:''}Les métriques natives ne sont jamais additionnées à la valeur patrimoniale EUR.`
      : collapsedCount>0
        ?`${collapsedCount} snapshot${collapsedCount>1?'s':''} identique${collapsedCount>1?'s':''} regroupé${collapsedCount>1?'s':''} sur le graphique. Les métriques natives ne sont jamais additionnées à la valeur patrimoniale EUR.`
        :`Les courbes montrent des métriques de plateforme. Elles ne sont jamais additionnées à la valeur patrimoniale EUR.`);

  if(!data.length){
    empty.textContent='Aucun snapshot exploitable pour cette période.';
    empty.hidden=false;
    return;
  }
  empty.hidden=true;

  const W=640,H=300,L=56,R=18,T=24,B=46;
  const plotW=W-L-R,plotH=H-T-B;
  const values=[];
  data.forEach(d=>{if(Number.isFinite(d.grid))values.push(d.grid);if(Number.isFinite(d.latent))values.push(d.latent)});
  let min=Math.min(...values),max=Math.max(...values);
  if(min===max){const pad=Math.max(1,Math.abs(min)*0.15);min-=pad;max+=pad}
  const extra=(max-min)*0.12||1;min-=extra;max+=extra;

  const x=i=>data.length===1?L+plotW/2:L+(i/(data.length-1))*plotW;
  const y=v=>T+((max-v)/(max-min))*plotH;

  // horizontal grid + labels
  for(let i=0;i<=4;i++){
    const yy=T+(i/4)*plotH;
    const val=max-(i/4)*(max-min);
    svg.appendChild(svgEl('line',{x1:L,y1:yy,x2:W-R,y2:yy,class:'chartGridLine'}));
    const tx=svgEl('text',{x:L-8,y:yy+5,'text-anchor':'end',class:'chartAxisLabel'});
    tx.textContent=Number(val.toFixed(2)).toLocaleString('fr-BE');
    svg.appendChild(tx);
  }
  if(min<0&&max>0){
    svg.appendChild(svgEl('line',{x1:L,y1:y(0),x2:W-R,y2:y(0),class:'chartZeroLine'}));
  }

  // x labels (first, middle, last)
  const labelIndexes=[0,Math.floor((data.length-1)/2),data.length-1].filter((v,i,a)=>a.indexOf(v)===i);
  labelIndexes.forEach(i=>{
    const tx=svgEl('text',{x:x(i),y:H-18,'text-anchor':'middle',class:'chartAxisLabel'});
    const d=data[i].date||'';
    let label=d ? d.slice(5).split('-').reverse().join('/') : '';
    if(data.length>1 && data.every(x=>x.date===d) && data[i].moment){
      try{label=new Date(data[i].moment).toLocaleTimeString('fr-BE',{hour:'2-digit',minute:'2-digit'})}catch{}
    }
    tx.textContent=label;
    svg.appendChild(tx);
  });

  const makePath=(key,cls)=>{
    const pts=data.map((d,i)=>Number.isFinite(d[key])?[x(i),y(d[key])]:null).filter(Boolean);
    if(!pts.length)return;
    if(pts.length===1){
      svg.appendChild(svgEl('circle',{cx:pts[0][0],cy:pts[0][1],r:6,class:key==='grid'?'chartGridDot':'chartLatentDot'}));
      return;
    }
    const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
    svg.appendChild(svgEl('path',{d,class:cls}));
    pts.forEach(p=>svg.appendChild(svgEl('circle',{cx:p[0],cy:p[1],r:4,class:key==='grid'?'chartGridDot':'chartLatentDot'})));
  };
  makePath('grid','chartGridPath');
  makePath('latent','chartLatentPath');

  // Internal movement markers: visual references only.
  const moves=botMovements(bot).filter(m=>m.date);
  const dates=data.map(d=>d.date);
  moves.forEach(m=>{
    const idx=dates.findIndex(d=>d>=m.date);
    if(idx<0)return;
    const xx=x(idx);
    svg.appendChild(svgEl('line',{x1:xx,y1:T,x2:xx,y2:T+plotH,class:'chartEventLine'}));
    svg.appendChild(svgEl('circle',{cx:xx,cy:T+8,r:4,class:'chartEventDot'}));
  });
}

function classLabel(v){return {MOBILISABLE:'Mobilisable',PROTECTED:'Long terme + réserve',ILLIQUID:'Illiquide financier'}[v]||v||'—'}
function locationTypeLabel(v){return {ACCOUNT:'Compte',ASSET:'Actif',BOT:'Bot',OTHER:'Autre'}[v]||v||'—'}
function confidenceLabel(v){return {CERTAIN:'Certain',ESTIMATED:'Estimé',TO_VERIFY:'À vérifier'}[v]||'Certain'}
function movementTypeLabel(v){return {CONTRIBUTION:'Apport extérieur',DISTRIBUTION:'Distribution extérieure',TRANSFER:'Transfert interne',FEE:'Frais'}[v]||v||'Mouvement'}

function locationById(id){return (currentState.locations||[]).find(l=>l.id===id)}
function botByLocation(id){return (currentState.bots||[]).find(b=>b.locationId===id)}

function renderPatrimoine(){
  const s=currentState;
  const sumClass=cls=>s.locations.filter(l=>l.class===cls).reduce((a,l)=>a+Number(l.balance||0),0);
  $('patMobilisable').textContent=money(sumClass('MOBILISABLE'));
  $('patProtected').textContent=money(sumClass('PROTECTED'));
  $('patIlliquid').textContent=money(sumClass('ILLIQUID'));
  $('patTotal').textContent=money(total(s));

  renderGeneralMovementOptions();

  $('patrimoineList').innerHTML=s.locations.map(l=>{
    const bot=botByLocation(l.id);
    return `<div class="locationCard">
      <h3>${escapeHtml(l.name)}</h3>
      <div class="locationMeta">
        <span class="locationTag">${escapeHtml(locationTypeLabel(l.type))}</span>
        <span class="locationTag">${escapeHtml(classLabel(l.class))}</span>
        ${bot?`<span class="locationTag">${escapeHtml(bot.status||'ACTIVE')}</span>`:''}
      </div>
      <div class="locationValueRow"><span>Valeur actuelle</span><b>${money(l.balance)}</b></div>
      <div class="locationValueRow"><span>Valeur d’ouverture</span><b>${money(l.baseline)}</b></div>
      ${l.note?`<div class="locationSourceNote">${escapeHtml(l.note)}</div>`:''}
      <details class="locationObserve">
        <summary>Mettre à jour la valeur observée</summary>
        <label>Nouvelle valeur EUR</label>
        <input data-loc-value="${l.id}" inputmode="decimal" placeholder="0,00">
        <label>Date d’observation</label>
        <input data-loc-date="${l.id}" type="date" value="${new Date().toISOString().slice(0,10)}">
        <label>Confiance</label>
        <select data-loc-confidence="${l.id}">
          <option value="CERTAIN">Certain</option>
          <option value="ESTIMATED">Estimé</option>
          <option value="TO_VERIFY">À vérifier</option>
        </select>
        <button type="button" data-save-loc-observation="${l.id}">Enregistrer l’observation</button>
      </details>
    </div>`;
  }).join('')||'<div class="muted">Aucun actif ou emplacement.</div>';

  document.querySelectorAll('[data-save-loc-observation]').forEach(btn=>{
    btn.addEventListener('click',()=>saveLocationObservation(btn.dataset.saveLocObservation));
  });
}
function renderGeneralMovementOptions(){
  const opts=(currentState.locations||[]).map(l=>`<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('');
  $('generalMoveFrom').innerHTML=opts;
  $('generalMoveTo').innerHTML=opts;
  if(!$('generalMoveDate').value)$('generalMoveDate').value=new Date().toISOString().slice(0,10);
  updateGeneralMovementForm();
}
function updateGeneralMovementForm(){
  const type=$('generalMoveType').value;
  $('generalMoveFromWrap').hidden=type==='CONTRIBUTION';
  $('generalMoveToWrap').hidden=type==='DISTRIBUTION';
}
async function saveGeneralMovement(){
  const type=$('generalMoveType').value;
  const value=parseLocalizedNumber($('generalMoveAmount').value);
  if(value===null||value<=0)return alert('Saisis un montant EUR supérieur à zéro.');
  const date=$('generalMoveDate').value||new Date().toISOString().slice(0,10);
  const m={id:uid(),type,value,date,createdAt:nowIso(),sourceType:'MANUAL',confidence:'CERTAIN',note:$('generalMoveNote').value.trim()};

  if(type==='CONTRIBUTION'){
    if(!$('generalMoveTo').value)return alert('Choisis la destination.');
    m.to=$('generalMoveTo').value;m.locationId=m.to;
  }else if(type==='DISTRIBUTION'){
    if(!$('generalMoveFrom').value)return alert('Choisis la source.');
    m.from=$('generalMoveFrom').value;m.locationId=m.from;
  }else{
    if(!$('generalMoveFrom').value||!$('generalMoveTo').value)return alert('Choisis la source et la destination.');
    if($('generalMoveFrom').value===$('generalMoveTo').value)return alert('La source et la destination doivent être différentes.');
    m.from=$('generalMoveFrom').value;m.to=$('generalMoveTo').value;
  }

  currentState.movements.push(m);
  currentState.auditEvents.push({id:uid(),type:'MOVEMENT_CREATED',movementId:m.id,createdAt:nowIso()});
  await saveState();
  $('generalMoveAmount').value='';$('generalMoveNote').value='';
  renderPatrimoine();renderDashboard();renderHistory();
}
async function saveLocationObservation(id){
  const l=locationById(id);if(!l)return;
  const value=parseLocalizedNumber(document.querySelector(`[data-loc-value="${id}"]`)?.value);
  if(value===null||value<0)return alert('Saisis une valeur EUR valide.');
  const date=document.querySelector(`[data-loc-date="${id}"]`)?.value||new Date().toISOString().slice(0,10);
  const confidence=document.querySelector(`[data-loc-confidence="${id}"]`)?.value||'CERTAIN';
  const observedAt=`${date}T${new Date().toTimeString().slice(0,8)}`;

  l.balance=value;l.lastObservedAt=observedAt;l.confidence=confidence;
  currentState.observations.push({id:uid(),locationId:id,value,date,observedAt,confidence,sourceType:'MANUAL'});
  const bot=botByLocation(id);
  if(bot){bot.value=value;bot.valueObservedAt=observedAt;bot.valueSource='MANUAL_OBSERVATION'}
  currentState.auditEvents.push({id:uid(),type:'LOCATION_OBSERVED',locationId:id,value,confidence,createdAt:nowIso()});
  await saveState();
  renderPatrimoine();renderDashboard();renderBots();
}
async function saveNewLocation(){
  const name=$('newLocName').value.trim();
  if(!name)return alert('Donne un nom à cet actif.');
  const baselineValue=parseLocalizedNumber($('newLocBaseline').value)??0;
  const currentValue=parseLocalizedNumber($('newLocValue').value)??baselineValue;
  if(baselineValue<0||currentValue<0)return alert('Les valeurs doivent être positives ou nulles.');
  const id='loc-'+uid();
  currentState.locations.push({
    id,name,type:$('newLocType').value,class:$('newLocClass').value,
    baseline:baselineValue,balance:currentValue,
    lastObservedAt:nowIso(),confidence:'CERTAIN'
  });
  currentState.auditEvents.push({id:uid(),type:'LOCATION_CREATED',locationId:id,createdAt:nowIso()});
  await saveState();
  $('newLocName').value='';$('newLocBaseline').value='';$('newLocValue').value='';$('addLocationPanel').hidden=true;
  renderPatrimoine();renderDashboard();renderEntityOptions();
}

function historyMoment(item){
  return item.createdAt||item.capturedAt||item.observedAt||(item.date?`${item.date}T12:00:00`:'');
}
function hasMovementReversal(id){return (currentState.movements||[]).some(m=>m.reversalOf===id)}
function movementDisplayRoute(m){
  const from=locationById(m.from)?.name;
  const to=locationById(m.to)?.name;
  if(m.type==='CONTRIBUTION')return to?`Extérieur → ${to}`:'Extérieur → portefeuille';
  if(m.type==='DISTRIBUTION')return from?`${from} → extérieur`:'Portefeuille → extérieur';
  if(m.type==='TRANSFER')return `${from||'—'} → ${to||'—'}`;
  if(m.type==='FEE')return locationById(m.locationId)?.name||botByLocation(m.locationId)?.name||'Bot / portefeuille';
  return '';
}
async function reverseMovement(id){
  const original=(currentState.movements||[]).find(m=>m.id===id);
  if(!original)return;
  if(original.reversalOf)return alert('Cette ligne est déjà une contre-écriture.');
  if(hasMovementReversal(id))return alert('Ce mouvement a déjà été annulé.');
  if(!confirm('Créer une contre-écriture de ce mouvement ? L’événement d’origine sera conservé.'))return;
  const rev={
    ...original,id:uid(),value:-Number(original.value||0),
    date:new Date().toISOString().slice(0,10),createdAt:nowIso(),
    reversalOf:original.id,note:`Annulation · ${original.note||movementTypeLabel(original.type)}`,
    sourceType:'MANUAL',confidence:'CERTAIN'
  };
  delete rev.documentId;
  currentState.movements.push(rev);
  currentState.auditEvents.push({id:uid(),type:'MOVEMENT_REVERSED',movementId:original.id,reversalId:rev.id,createdAt:nowIso()});
  await saveState();renderHistory();renderDashboard();renderBots();
}
function renderHistory(){
  const filter=$('historyFilter').value||'ALL';
  const items=[];
  if(filter==='ALL'||filter==='MOVEMENTS'){
    for(const m of currentState.movements||[])items.push({kind:'MOVEMENT',moment:historyMoment(m),data:m});
  }
  if(filter==='ALL'||filter==='SNAPSHOTS'){
    for(const s of currentState.snapshots||[])items.push({kind:'SNAPSHOT',moment:historyMoment(s),data:s});
  }
  if(filter==='ALL'||filter==='AUDIT'){
    for(const a of currentState.auditEvents||[])items.push({kind:'AUDIT',moment:historyMoment(a),data:a});
  }
  items.sort((a,b)=>String(b.moment).localeCompare(String(a.moment)));

  $('historyList').innerHTML=items.map(item=>{
    if(item.kind==='MOVEMENT'){
      const m=item.data;
      const reversed=hasMovementReversal(m.id);
      const reversal=!!m.reversalOf;
      return `<div class="historyItem">
        <div class="historyHead"><b>${escapeHtml(movementTypeLabel(m.type))}${reversal?'<span class="reversalTag">CONTRE-ÉCRITURE</span>':''}</b><span>${escapeHtml(m.date||'Sans date')}</span></div>
        <div class="historyBody">${escapeHtml(movementDisplayRoute(m))} · ${money(m.value)}${m.note?` · ${escapeHtml(m.note)}`:''}</div>
        ${!reversal&&!reversed?`<div class="historyActions"><button type="button" data-reverse-movement="${m.id}">Annuler par contre-écriture</button></div>`:''}
        ${reversed?'<div class="historyBody">Déjà annulé par une contre-écriture.</div>':''}
      </div>`;
    }
    if(item.kind==='SNAPSHOT'){
      const s=item.data,bot=(currentState.bots||[]).find(b=>b.id===s.botId);
      return `<div class="historyItem">
        <div class="historyHead"><b>Snapshot · ${escapeHtml(bot?.name||'Bot')}</b><span>${escapeHtml(s.date||'Sans date')}</span></div>
        <div class="historyBody">Grid Profit ${formatNative(snapshotGrid(s),snapshotUnit(s))} · P&L latent ${formatNative(snapshotLatent(s),snapshotUnit(s))} · ${escapeHtml(confidenceLabel(s.confidence))}</div>
      </div>`;
    }
    const a=item.data;
    return `<div class="historyItem">
      <div class="historyHead"><b>Audit · ${escapeHtml(a.type||'Événement')}</b><span>${escapeHtml((a.createdAt||'').slice(0,16).replace('T',' '))}</span></div>
    </div>`;
  }).join('')||'<div class="muted">Aucun événement pour ce filtre.</div>';

  document.querySelectorAll('[data-reverse-movement]').forEach(btn=>{
    btn.addEventListener('click',()=>reverseMovement(btn.dataset.reverseMovement));
  });
}

function goalProgressCard(label,current,target){
  const pct=target>0?Math.min(100,Math.max(0,current/target*100)):0;
  return `<div class="goalProgressCard">
    <div class="top"><b>${escapeHtml(label)}</b><span>${target>0?`${money(current)} / ${money(target)} · ${pct.toFixed(1)}%`:'Objectif non défini'}</span></div>
    <div class="progressTrack"><div class="progressFill" style="width:${pct}%"></div></div>
  </div>`;
}
function renderGoals(){
  const g=currentState.goals||{};
  $('goalWealth').value=g.wealth||'';
  $('goalProtected').value=g.protected||'';
  $('goalBotMaxPct').value=g.botMaxPct||'';
  $('goalNote').value=g.note||'';
  const protectedValue=currentState.locations.filter(l=>l.class==='PROTECTED').reduce((a,l)=>a+Number(l.balance||0),0);
  const botValue=currentState.bots.reduce((a,b)=>a+Number(b.value||0),0);
  const botPct=total(currentState)>0?botValue/total(currentState)*100:0;
  $('goalsProgress').innerHTML=
    goalProgressCard('Capital financier',total(currentState),Number(g.wealth||0))
    +goalProgressCard('Long terme + réserve',protectedValue,Number(g.protected||0))
    +`<div class="goalProgressCard"><div class="top"><b>Allocation bots</b><span>${botPct.toFixed(1)} %${Number(g.botMaxPct||0)>0?` / max ${Number(g.botMaxPct).toFixed(1)} %`:''}</span></div>
      <div class="progressTrack"><div class="progressFill" style="width:${Math.min(100,botPct)}%"></div></div></div>`
    +(g.note?`<div class="muted">${escapeHtml(g.note)}</div>`:'');
}
async function saveGoals(){
  const wealth=parseLocalizedNumber($('goalWealth').value)??0;
  const protectedTarget=parseLocalizedNumber($('goalProtected').value)??0;
  const botMaxPct=parseLocalizedNumber($('goalBotMaxPct').value)??0;
  currentState.goals={wealth,protected:protectedTarget,botMaxPct,note:$('goalNote').value.trim()};
  currentState.auditEvents.push({id:uid(),type:'GOALS_UPDATED',createdAt:nowIso()});
  await saveState();renderGoals();renderDashboard();
}

function duplicateIdCount(){
  const ids=[
    ...(currentState.locations||[]).map(x=>x.id),
    ...(currentState.bots||[]).map(x=>x.id),
    ...(currentState.movements||[]).map(x=>x.id),
    ...(currentState.snapshots||[]).map(x=>x.id)
  ];
  return ids.length-new Set(ids).size;
}
function stateQualityChecks(s){
  const checks=[];
  const negatives=s.locations.filter(l=>Number(l.balance||0)<0);
  checks.push({name:'Soldes négatifs',level:negatives.length?'BAD':'OK',detail:negatives.length?`${negatives.length} emplacement(s)`:'Aucun'});

  const noSnap=s.bots.filter(b=>b.status==='ACTIVE'&&!s.snapshots.some(x=>x.botId===b.id));
  checks.push({name:'Bots actifs sans snapshot',level:noSnap.length?'WARN':'OK',detail:noSnap.length?`${noSnap.length} bot(s)`:'Tous couverts'});

  const reconcile=s.bots.filter(b=>b.status==='ACTIVE'&&botNeedsReconciliation(b));
  checks.push({name:'Réconciliations bots',level:reconcile.length?'WARN':'OK',detail:reconcile.length?`${reconcile.length} en attente`:'À jour'});

  const unknownFees=s.movements.filter(m=>m.type==='FEE'&&(!m.feeTreatment||m.feeTreatment==='UNKNOWN'));
  checks.push({name:'Frais à qualifier',level:unknownFees.length?'WARN':'OK',detail:unknownFees.length?`${unknownFees.length} frais`:'Aucun'});

  const staleLocations=s.locations.filter(l=>{const d=daysSince(latestObservationMomentForLocation(s,l));return d===null||d>30});
  checks.push({name:'Valeurs de plus de 30 jours',level:staleLocations.length?'WARN':'OK',detail:staleLocations.length?`${staleLocations.length} actif(s)`:'Aucune'});

  const dup=duplicateIdCount();
  checks.push({name:'Identifiants dupliqués',level:dup?'BAD':'OK',detail:dup?`${dup} doublon(s)`:'Aucun'});

  const closedNonZero=s.bots.filter(b=>b.status==='CLOSED'&&Math.abs(Number(b.value||0))>0.01);
  checks.push({name:'Bots clôturés avec valeur',level:closedNonZero.length?'BAD':'OK',detail:closedNonZero.length?`${closedNonZero.length} bot(s)`:'Aucun'});

  return checks;
}
async function renderQuality(){
  const s=currentState;
  const docs=await getDocMetas();
  const items=[
    ...(s.snapshots||[]),
    ...(s.movements||[]),
    ...(s.observations||[]),
    ...docs
  ];
  const count=v=>items.filter(x=>(x.confidence||'CERTAIN')===v).length;
  const checks=stateQualityChecks(s);
  $('qualityCertain').textContent=count('CERTAIN');
  $('qualityEstimated').textContent=count('ESTIMATED');
  $('qualityVerify').textContent=count('TO_VERIFY');
  $('qualityAlerts').textContent=checks.filter(x=>x.level!=='OK').length;

  $('qualityChecks').innerHTML=checks.map(c=>`<div class="qualityCheck">
    <span>${escapeHtml(c.name)}</span><b class="${c.level==='OK'?'qualityOk':c.level==='WARN'?'qualityWarn':'qualityBad'}">${escapeHtml(c.level==='OK'?'OK':c.level==='WARN'?'À surveiller':'Alerte')} · ${escapeHtml(c.detail)}</b>
  </div>`).join('');

  const sourceCounts={MANUAL:0,SCREENSHOT:0,PHOTO:0,CSV:0,API:0,DEMO:0};
  for(const x of items){const k=x.sourceType||'MANUAL';sourceCounts[k]=(sourceCounts[k]||0)+1}
  $('qualitySources').innerHTML=Object.entries(sourceCounts).map(([k,v])=>`<div class="qualityCheck"><span>${escapeHtml(k)}</span><b>${v}</b></div>`).join('')
    +`<div class="qualityCheck"><span>Dernière sauvegarde</span><b>${escapeHtml(s.settings?.lastBackupAt?new Date(s.settings.lastBackupAt).toLocaleString('fr-BE'):'Jamais enregistrée')}</b></div>`;
}

function currentTaxScenario(){
  const year=String($('fiscalYear').value||new Date().getFullYear());
  currentState.taxScenarios=currentState.taxScenarios||{};
  return currentState.taxScenarios[year]||{realized:0,otherIncome:0,lossOffset:0,allowance:0,rate:0};
}
function renderTaxScenario(){
  const sc=currentTaxScenario();
  $('taxRealized').value=sc.realized||'';
  $('taxOtherIncome').value=sc.otherIncome||'';
  $('taxLossOffset').value=sc.lossOffset||'';
  $('taxAllowance').value=sc.allowance||'';
  $('taxProvisionRate').value=sc.rate||'';
  const base=Math.max(0,Number(sc.realized||0)+Number(sc.otherIncome||0)-Number(sc.lossOffset||0)-Number(sc.allowance||0));
  const reserve=base*Math.max(0,Number(sc.rate||0))/100;
  $('taxEstimatedBase').textContent=money(base);
  $('taxEstimatedReserve').textContent=money(reserve);
}
async function saveTaxScenario(){
  const year=String($('fiscalYear').value||new Date().getFullYear());
  currentState.taxScenarios=currentState.taxScenarios||{};
  currentState.taxScenarios[year]={
    realized:parseLocalizedNumber($('taxRealized').value)??0,
    otherIncome:parseLocalizedNumber($('taxOtherIncome').value)??0,
    lossOffset:parseLocalizedNumber($('taxLossOffset').value)??0,
    allowance:parseLocalizedNumber($('taxAllowance').value)??0,
    rate:parseLocalizedNumber($('taxProvisionRate').value)??0
  };
  currentState.fiscal.country=$('fiscalCountry').value;
  currentState.auditEvents.push({id:uid(),type:'TAX_SCENARIO_UPDATED',year,createdAt:nowIso()});
  await saveState();renderTaxScenario();
}

function renderBotLifecycle(bot){
  const closed=bot.status==='CLOSED';
  $('botLifecycleStatus').innerHTML=closed
    ?`Bot clôturé le <b>${escapeHtml(bot.closedAt||'date inconnue')}</b>.`
    :`Bot actif. Les changements de stratégie n’interrompent pas la performance GridLedger.`;
  $('botCloseDetails').hidden=closed;
  if(!$('botCloseDate').value)$('botCloseDate').value=new Date().toISOString().slice(0,10);
  if(!$('strategyDate').value)$('strategyDate').value=new Date().toISOString().slice(0,10);

  const destinations=currentState.locations.filter(l=>l.id!==bot.locationId);
  $('botCloseDestination').innerHTML=destinations.map(l=>`<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('');

  const epochs=(currentState.strategyEpochs||[]).filter(e=>e.botId===bot.id).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  $('strategyHistory').innerHTML=epochs.map(e=>`<div class="strategyItem"><b>${escapeHtml(e.date)} · changement de stratégie</b><span>${escapeHtml(e.note||'Sans note')}</span></div>`).join('');
}
async function saveStrategyEpoch(){
  const bot=currentState.bots.find(b=>b.id===selectedBotId);if(!bot)return;
  const date=$('strategyDate').value||new Date().toISOString().slice(0,10);
  const note=$('strategyNote').value.trim();
  currentState.strategyEpochs.push({id:uid(),botId:bot.id,date,note,createdAt:nowIso()});
  currentState.auditEvents.push({id:uid(),type:'STRATEGY_EPOCH_CREATED',botId:bot.id,date,createdAt:nowIso()});
  await saveState();$('strategyNote').value='';renderBotLifecycle(bot);
}
async function closeBotLifecycle(){
  const bot=currentState.bots.find(b=>b.id===selectedBotId);if(!bot||bot.status==='CLOSED')return;
  const dest=$('botCloseDestination').value;
  const amount=parseLocalizedNumber($('botCloseAmount').value)??0;
  const date=$('botCloseDate').value||new Date().toISOString().slice(0,10);
  if(!dest)return alert('Choisis une destination de récupération.');
  if(amount<0)return alert('Le montant récupéré ne peut pas être négatif.');
  if(!confirm('Clôturer ce bot ? GridLedger créera le transfert de récupération et mettra la valeur du bot à zéro.'))return;

  if(amount>0){
    currentState.movements.push({
      id:uid(),type:'TRANSFER',value:amount,from:bot.locationId,to:dest,
      date,createdAt:nowIso(),sourceType:'MANUAL',confidence:'CERTAIN',
      botId:bot.id,botRole:'CAPITAL_RETURN',note:'Récupération à la clôture'
    });
  }
  bot.status='CLOSED';bot.closedAt=date;bot.value=0;bot.valueObservedAt=nowIso();
  const loc=locationById(bot.locationId);if(loc){loc.balance=0;loc.lastObservedAt=bot.valueObservedAt}
  currentState.auditEvents.push({id:uid(),type:'BOT_CLOSED',botId:bot.id,date,createdAt:nowIso()});
  await saveState();await renderBotDetail();renderBots();renderDashboard();
}

function xmlText(bytes){return new TextDecoder('utf-8').decode(bytes)}
function u16(view,o){return view.getUint16(o,true)}
function u32(view,o){return view.getUint32(o,true)}

async function inflateRawBrowser(bytes){
  if(typeof DecompressionStream==='undefined'){
    throw new Error("Ce navigateur ne permet pas encore de décompresser le fichier Excel localement.");
  }
  const ds=new DecompressionStream('deflate-raw');
  const stream=new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzipXlsx(arrayBuffer){
  const bytes=new Uint8Array(arrayBuffer),view=new DataView(arrayBuffer);
  let eocd=-1;
  const min=Math.max(0,bytes.length-65557);
  for(let i=bytes.length-22;i>=min;i--){
    if(view.getUint32(i,true)===0x06054b50){eocd=i;break}
  }
  if(eocd<0)throw new Error("Fichier Excel invalide : archive ZIP introuvable.");

  const entries=u16(view,eocd+10);
  let p=u32(view,eocd+16);
  const files={};

  for(let n=0;n<entries;n++){
    if(u32(view,p)!==0x02014b50)throw new Error("Structure XLSX non reconnue.");
    const compression=u16(view,p+10);
    const compressedSize=u32(view,p+20);
    const fileNameLength=u16(view,p+28);
    const extraLength=u16(view,p+30);
    const commentLength=u16(view,p+32);
    const localOffset=u32(view,p+42);
    const name=new TextDecoder('utf-8').decode(bytes.slice(p+46,p+46+fileNameLength));

    if(u32(view,localOffset)!==0x04034b50)throw new Error("Entrée XLSX endommagée.");
    const localNameLength=u16(view,localOffset+26);
    const localExtraLength=u16(view,localOffset+28);
    const dataStart=localOffset+30+localNameLength+localExtraLength;
    const compressed=bytes.slice(dataStart,dataStart+compressedSize);

    if(compression===0)files[name]=compressed;
    else if(compression===8)files[name]=await inflateRawBrowser(compressed);
    else throw new Error("Compression XLSX non prise en charge : "+compression);

    p+=46+fileNameLength+extraLength+commentLength;
  }
  return files;
}

function parseXml(bytes){
  const doc=new DOMParser().parseFromString(xmlText(bytes),'application/xml');
  if(doc.querySelector('parsererror'))throw new Error("XML Excel illisible.");
  return doc;
}
function sharedStringsFrom(files){
  const raw=files['xl/sharedStrings.xml'];
  if(!raw)return [];
  const doc=parseXml(raw);
  return Array.from(doc.getElementsByTagName('si')).map(si=>
    Array.from(si.getElementsByTagName('t')).map(t=>t.textContent||'').join('')
  );
}
function sheetPathByName(files,name){
  const workbook=parseXml(files['xl/workbook.xml']);
  const sheet=Array.from(workbook.getElementsByTagName('sheet')).find(s=>s.getAttribute('name')===name);
  if(!sheet)throw new Error(`Onglet "${name}" introuvable.`);
  const rid=sheet.getAttribute('r:id')||
    sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
  const rels=parseXml(files['xl/_rels/workbook.xml.rels']);
  const rel=Array.from(rels.getElementsByTagName('Relationship')).find(r=>r.getAttribute('Id')===rid);
  if(!rel)throw new Error(`Relation de l'onglet "${name}" introuvable.`);
  let target=(rel.getAttribute('Target')||'').replace(/^\/+/,'');
  if(target.startsWith('xl/'))return target;
  return 'xl/'+target.replace(/^(\.\.\/)+/,'');
}
function readSheetCells(files,name,shared){
  const path=sheetPathByName(files,name);
  if(!files[path])throw new Error(`Contenu de l'onglet "${name}" introuvable.`);
  const doc=parseXml(files[path]),map={};
  for(const c of Array.from(doc.getElementsByTagName('c'))){
    const ref=c.getAttribute('r'),type=c.getAttribute('t');
    let value='';
    if(type==='inlineStr'){
      value=Array.from(c.getElementsByTagName('t')).map(t=>t.textContent||'').join('');
    }else{
      const v=c.getElementsByTagName('v')[0]?.textContent??'';
      if(type==='s')value=shared[Number(v)]??'';
      else if(type==='b')value=v==='1';
      else value=v===''?'':Number(v);
    }
    map[ref]=value;
  }
  return map;
}
function requireNumberCell(cells,ref,label){
  const v=Number(cells[ref]);
  if(!Number.isFinite(v))throw new Error(`${label} (${ref}) est absent ou invalide.`);
  return v;
}

function importedPlanningHtml(p){
  if(!p||!p.importedAt)return '';
  return `<div class="planningBox">
    <b>Plan financier lu dans le tableau · immobilier exclu</b>
    <div><span>Bots 2026</span><strong>${money(p.botMonthly2026)}/mois</strong></div>
    <div><span>Bots à partir de 2027</span><strong>${money(p.botMonthlyFrom2027)}/mois</strong></div>
    <div><span>BTC long terme</span><strong>${money(p.btcMonthly)}/mois</strong></div>
    <div><span>ETF</span><strong>dès ${escapeHtml(p.etfStartYear)} · ${money(p.etfMonthly)}/mois</strong></div>
    <div><span>Cible minimum</span><strong>${money(p.targetMinimum)}</strong></div>
    <div><span>Cible confortable</span><strong>${money(p.targetComfortable)}</strong></div>
  </div>`;
}
function renderImportedPlanning(){
  const box=$('planningImported');
  if(box)box.innerHTML=importedPlanningHtml(currentState?.planning);
  const status=$('baseWorkbookStatus');
  if(status){
    status.textContent=currentState?.planning?.importedAt
      ?`Tableau importé le ${new Date(currentState.planning.importedAt).toLocaleString('fr-BE')}.`
      :'Aucun tableau importé.';
  }
}

async function importBaseWorkbook(file){
  if(!file)return;
  const status=$('baseWorkbookStatus');
  status.textContent='Lecture locale du tableau…';

  try{
    const files=await unzipXlsx(await file.arrayBuffer());
    const shared=sharedStringsFrom(files);
    const h=readSheetCells(files,'Hypotheses',shared);

    const botCapital=requireNumberCell(h,'B12','Capital initial bots');
    const botMonthly2026=requireNumberCell(h,'B13','Apport mensuel bots 2026');
    const botMonthlyFrom2027=requireNumberCell(h,'B14','Apport mensuel bots à partir de 2027');
    const btcInitial=requireNumberCell(h,'B19','BTC long terme initial');
    const btcMonthly=requireNumberCell(h,'B20','Apport mensuel BTC');
    const reserveInitial=requireNumberCell(h,'B25','Réserve initiale');
    const etfStartYear=requireNumberCell(h,'B28','Année de début ETF');
    const etfMonthly=requireNumberCell(h,'B29','Apport mensuel ETF');

    const budgetMinimum=requireNumberCell(h,'B44','Budget minimum');
    const budgetComfortable=requireNumberCell(h,'B45','Budget confortable');
    const withdrawalRate=requireNumberCell(h,'B46','Taux de retrait');
    const targetMinimum=requireNumberCell(h,'B47','Capital cible minimum');
    const targetComfortable=requireNumberCell(h,'B48','Capital cible confortable');

    const initialTotal=botCapital+btcInitial+reserveInitial;

    const hasExisting=currentState.locations.length||currentState.movements.length||
      currentState.snapshots.length||currentState.bots.length;
    if(hasExisting){
      const ok=confirm(
        `Cette importation remplacera la situation initiale actuellement présente dans ce coffre.\n\n`+
        `Valeur initiale lue : ${money(initialTotal)}.\n\nContinuer ?`
      );
      if(!ok){status.textContent='Importation annulée.';return}
    }

    const importedAt=nowIso();

    currentState.locations=[
      {
        id:'bots-crypto-aggregate',
        name:'Bots crypto — Bybit + Pionex (agrégé)',
        type:'BOT',class:'MOBILISABLE',
        baseline:botCapital,balance:botCapital,lastObservedAt:importedAt,confidence:'CERTAIN',
        note:'Valeur d’ouverture agrégée du tableau. La répartition Bybit/Pionex n’est pas inventée : elle sera ventilée quand les montants séparés seront disponibles.'
      },
      {
        id:'btc-bitstack',name:'BTC long terme — Bitstack',
        type:'ASSET',class:'PROTECTED',
        baseline:btcInitial,balance:btcInitial,lastObservedAt:importedAt,confidence:'CERTAIN',
        note:'Valeur d’ouverture. Ce n’est pas un nouvel apport.'
      },
      {
        id:'reserve-bybit',name:'Réserve — Earn Bybit',
        type:'ACCOUNT',class:'PROTECTED',
        baseline:reserveInitial,balance:reserveInitial,lastObservedAt:importedAt,confidence:'CERTAIN',
        note:'Réserve importée comme valeur d’ouverture.'
      }
    ];

    currentState.bots=[
      {
        id:'bot-crypto-aggregate',name:'Bots crypto — Bybit + Pionex',
        platform:'Bybit + Pionex',pair:'Agrégé · à ventiler',
        locationId:'bots-crypto-aggregate',baseline:botCapital,value:botCapital,
        valueObservedAt:importedAt,valueSource:'BASE_WORKBOOK',status:'ACTIVE',
        note:'Agrégation temporaire : le tableau source ne fournit pas le partage Bybit/Pionex.'
      }
    ];

    currentState.movements=[];
    currentState.snapshots=[];
    currentState.observations=[
      {id:uid(),locationId:'bots-crypto-aggregate',value:botCapital,observedAt:importedAt,date:importedAt.slice(0,10),confidence:'CERTAIN',sourceType:'BASE_WORKBOOK'},
      {id:uid(),locationId:'btc-bitstack',value:btcInitial,observedAt:importedAt,date:importedAt.slice(0,10),confidence:'CERTAIN',sourceType:'BASE_WORKBOOK'},
      {id:uid(),locationId:'reserve-bybit',value:reserveInitial,observedAt:importedAt,date:importedAt.slice(0,10),confidence:'CERTAIN',sourceType:'BASE_WORKBOOK'}
    ];
    currentState.strategyEpochs=[];

    currentState.goals={
      wealth:targetMinimum,protected:0,botMaxPct:0,
      note:`Cible confortable : ${money(targetComfortable)}. Budget mensuel visé : ${money(budgetMinimum)} minimum / ${money(budgetComfortable)} confortable. Taux de retrait du tableau : ${(withdrawalRate*100).toFixed(1)} %/an.`
    };
    currentState.planning={
      importedAt,sourceFileName:file.name,source:'TABLEAU_DE_BASE',
      botMonthly2026,botMonthlyFrom2027,btcMonthly,etfStartYear,etfMonthly,
      targetMinimum,targetComfortable,budgetMinimum,budgetComfortable,withdrawalRate
    };
    currentState.auditEvents=[
      {id:uid(),type:'BASE_WORKBOOK_IMPORTED',fileName:file.name,initialTotal,createdAt:importedAt}
    ];
    currentState.updated=importedAt.slice(0,10);

    await saveState();
    renderAll();
    status.textContent=`Import réussi · situation initiale : ${money(initialTotal)}.`;
    alert(
      `Importation terminée.\n\nSituation initiale GridLedger : ${money(initialTotal)}.\n\n`+
      `Les versements futurs et les rendements projetés n'ont pas été enregistrés comme opérations réelles.`
    );
  }catch(err){
    console.error(err);
    status.textContent='Import impossible : '+(err?.message||String(err));
    alert('Import impossible : '+(err?.message||String(err)));
  }
}
function renderEntityOptions(){
  const s=currentState;
  $('docEntity').innerHTML='<option value="">Aucun élément</option>'+[
    ...s.bots.map(b=>`<option value="BOT:${b.id}">Bot · ${escapeHtml(b.name)}</option>`),
    ...s.locations.filter(l=>l.type!=='BOT').map(l=>`<option value="LOCATION:${l.id}">${escapeHtml(l.name)}</option>`)
  ].join('');
}
async function renderDocuments(){
  renderEntityOptions();
  const docs=await getDocMetas();let totalBytes=0;docs.forEach(d=>totalBytes+=d.size||0);
  $('storageInfo').textContent=`${docs.length} fichier(s) · ${(totalBytes/1024/1024).toFixed(2)} Mo`;
  $('documentsList').innerHTML=docs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(d=>`
    <div class="docCard">
      <h3>${escapeHtml(d.title||d.fileName)}</h3>
      <div class="kv"><span>Année</span><b>${d.year}</b></div>
      <div class="kv"><span>Catégorie</span><b>${escapeHtml(d.category)}</b></div>
      <div class="kv"><span>Fiscal</span><b>${d.includeTax?'Oui':'Non'}</b></div>
      <div class="kv"><span>Fichier</span><b>${escapeHtml(d.fileName)}</b></div>
      <div class="docActions"><button onclick="openDocument('${d.id}')">Ouvrir</button><button class="danger" onclick="removeDocument('${d.id}')">Supprimer</button></div>
    </div>`).join('')||'<div class="muted">Aucun document enregistré.</div>';
}
async function renderFiscal(){
  const docs=await getDocMetas();
  const years=[...new Set([new Date().getFullYear(),...docs.map(d=>Number(d.year))])].sort((a,b)=>b-a);
  const fy=$('fiscalYear'),previous=fy.value;
  fy.innerHTML=years.map(y=>`<option>${y}</option>`).join('');
  if(previous&&years.includes(Number(previous)))fy.value=previous;
  const year=Number(fy.value||years[0]),taxDocs=docs.filter(d=>d.includeTax&&Number(d.year)===year);
  $('fiscalDocs').textContent=taxDocs.length;
  $('fiscalSources').textContent=new Set(taxDocs.map(d=>d.category)).size;
  $('fiscalVerify').textContent=taxDocs.filter(d=>d.confidence==='TO_VERIFY').length;
  $('fiscalDocuments').innerHTML=taxDocs.map(d=>`<div class="docCard"><h3>${escapeHtml(d.title||d.fileName)}</h3><div class="kv"><span>Catégorie</span><b>${escapeHtml(d.category)}</b></div><div class="kv"><span>Note</span><b>${escapeHtml(d.note||'—')}</b></div></div>`).join('')||'<div class="muted">Aucune pièce fiscale pour cette année.</div>';
  $('fiscalCountry').value=currentState.fiscal?.country||'MANUAL';
  renderTaxScenario();
}
function renderAll(){if(!currentState)return;ensureStateShape(currentState);if($('appVersion'))$('appVersion').textContent=APP_VERSION;renderDashboard();renderBots();renderEntityOptions();renderDocCounts();renderImportedPlanning();if($('patrimoine')?.classList.contains('active'))renderPatrimoine();if($('history')?.classList.contains('active'))renderHistory();if($('goals')?.classList.contains('active'))renderGoals();if($('quality')?.classList.contains('active'))renderQuality();if($('assistant')?.classList.contains('active'))renderAssistant()}

function parseLocalizedNumber(v){
  let s=String(v??'').trim().replace(/\u00a0/g,' ').replace(/\s/g,'');
  if(!s)return null;
  const c=s.lastIndexOf(','),d=s.lastIndexOf('.');
  if(c>-1&&d>-1){
    if(c>d)s=s.replace(/\./g,'').replace(',','.');
    else s=s.replace(/,/g,'');
  }else if(c>-1){
    s=s.replace(',','.');
  }else if(d>-1){
    const parts=s.split('.');
    if(parts.length>2){
      const dec=parts.pop();s=parts.join('')+'.'+dec;
    }
  }
  s=s.replace(/[^0-9+\-.]/g,'');
  const x=Number(s);return Number.isFinite(x)?x:null;
}
function extractByPatterns(text,patterns){
  for(const p of patterns){
    const m=text.match(p);
    if(m)return parseLocalizedNumber(m[1]);
  }
  return null;
}
function detectCaptureSource(text){
  const t=String(text||'');
  if(/pionex/i.test(t))return 'Pionex';
  const pionexSignals=[
    /Mes\s*bots/i,/Trading\s*en\s*grille/i,/P[nmN][LlI]\s*(?:de\s*)?tendance/i,
    /Tours?\s*d.?arbitrage/i,/Retir[ée]?/i,/Grille\/Total\s*annualis/i,
    /Grid\s*profit/i,/Plage\s*de\s*prix/i
  ].filter(r=>r.test(t)).length;
  if(pionexSignals>=2)return 'Pionex';
  if(/bybit/i.test(t))return 'Bybit';
  if(/bitstack/i.test(t))return 'Bitstack';
  if(/binance/i.test(t))return 'Binance';
  return $('captureSource').value.trim()||'Autre';
}
function detectQuoteUnit(text,pair){
  const quote=(String(pair||'').split('/')[1]||'').toUpperCase();
  if(quote)return quote;
  const m=String(text||'').match(/\b(USDT|USDC|FDUSD|EUR|USD|BTC|ETH)\b/i);
  return m?m[1].toUpperCase():'';
}
function formatNative(v,unit){
  if(v===null||v===undefined||v==='')return 'À vérifier';
  const num=Number(v);
  const rendered=Number.isFinite(num)?num.toLocaleString('fr-BE',{maximumFractionDigits:8}):String(v);
  return rendered+(unit?' '+unit:'');
}
function analyzeCapture(){
  const text=$('captureText').value||'';
  const kind=$('captureKind').value;
  const source=detectCaptureSource(text);
  if(!$('captureSource').value.trim()&&source!=='Autre')$('captureSource').value=source;

  const pairMatch=text.match(/\b([A-Z0-9]{2,12})\s*\/\s*([A-Z0-9]{2,12})\b/i);
  const pair=pairMatch?(pairMatch[1]+'/'+pairMatch[2]).toUpperCase():'';

  const investment=extractByPatterns(text,[
    /Investissement(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Investment\s*Amount[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Invested[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
  ]);
  const currentProfit=extractByPatterns(text,[
    /B[ée]n[ée]fice\s*(?:courant|c0urant|couran[tf])(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Current\s*Profit[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Total\s*(?:P&L|PnL)[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
  ]);
  const grid=extractByPatterns(text,[
    /Grid\s*profit(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Grid\s*Profit[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
  ]);
  const latent=extractByPatterns(text,[
    /P[nmN][LlI]\s*(?:de\s*)?tendance(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /P&L\s*latent[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Unrealized\s*(?:P&L|PnL)[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
  ]);
  const currentExplicit=extractByPatterns(text,[
    /Valeur\s*actuelle[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Current\s*Value[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Total\s*Value[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
  ]);
  const withdrawn=extractByPatterns(text,[
    /Retir[ée]?(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
    /Withdrawn[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
  ]);

  const unit=detectQuoteUnit(text,pair);
  const currentValue=currentExplicit;
  const detectedConfidence=(v)=>{
    if(v===null||v==='')return 'TO_VERIFY';
    if(captureOCRConfidence!==null && captureOCRConfidence<80)return 'TO_VERIFY';
    return 'ESTIMATED';
  };
  const currentValueConfidence=detectedConfidence(currentValue);

  captureParsed={
    source,kind,pair,unit,investment,currentProfit,grid,latent,currentValue,currentValueConfidence,withdrawn,
    ocrConfidence:captureOCRConfidence
  };

  const resultLines=[
    ['Source',source],
    ['Paire',pair||'À vérifier'],
    ['Devise détectée',unit||'À vérifier'],
    ['Investissement',formatNative(investment,unit)],
    ['Bénéfice courant / Total P&L',formatNative(currentProfit,unit)],
    ['Grid Profit',formatNative(grid,unit)],
    ['P&L latent / tendance',formatNative(latent,unit)],
    ['Valeur actuelle',formatNative(currentValue,unit)],
    ['Retiré',formatNative(withdrawn,unit)]
  ];
  $('captureResult').innerHTML=resultLines.map(x=>`<div class="kv"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('')+
    `<p class="muted">Vérifie les chiffres avant enregistrement.${captureOCRConfidence!==null?` <span class="advancedOnly">Confiance OCR : ${Math.round(captureOCRConfidence)} %.</span>`:''}</p>`;
  renderCaptureProposal();
}
function captureField(label,key,value,confidence){
  const cls=confidence==='CERTAIN'?'confCertain':confidence==='ESTIMATED'?'confEstimated':'confVerify';
  const canReread=!!PIONEX_FIELD_ZONES[key];
  const hasValue=value!==null&&value!==undefined&&String(value).trim()!=='';
  const confirmed=confidence==='CERTAIN';
  const statusLabel=confirmed?'Certain':confidence==='ESTIMATED'?'Estimé':'À vérifier';
  const statusClass=confirmed?'certain':confidence==='ESTIMATED'?'estimated':'verify';
  return `<div class="proposalField ${cls}" data-proposal="${key}" data-has-value="${hasValue?'1':'0'}" data-confirmed="${confirmed?'1':'0'}">
    <span>${label}</span>
    <input data-proposal-value="${key}" value="${value===null||value===undefined?'':escapeHtml(value)}">
    <span class="simpleStatus ${statusClass}" data-simple-status="${key}">${statusLabel}</span>
    <select data-proposal-conf="${key}">
      <option value="CERTAIN" ${confidence==='CERTAIN'?'selected':''}>Certain</option>
      <option value="ESTIMATED" ${confidence==='ESTIMATED'?'selected':''}>Estimé</option>
      <option value="TO_VERIFY" ${confidence==='TO_VERIFY'?'selected':''}>À vérifier</option>
    </select>
    ${canReread?`<button class="rereadFieldBtn advancedOnly" data-reread-field="${key}" type="button">Relire ce champ</button>
      <div class="fieldInlineDebug" data-inline-debug="${key}" hidden></div>
      <div class="fieldInlineActions" data-inline-actions="${key}">
        <button type="button" class="secondaryButton advancedOnly" data-view-zone="${key}" hidden>Voir la zone lue</button>
        ${key!=='pair'?`<button type="button" class="pointerFieldButton advancedOnly" data-pointer-field="${key}">Pointer le nombre</button>`:''}
        <button type="button" class="confirmFieldBtn" data-confirm-field="${key}">J’ai vérifié</button>
      </div>`:`<div class="fieldInlineActions"><button type="button" class="confirmFieldBtn" data-confirm-field="${key}">J’ai vérifié</button></div>`}
  </div>`;
}
function renderCaptureProposal(){
  if(!captureParsed)return;
  const p=captureParsed;
  $('captureProposalPanel').hidden=false;
  if(p.kind==='BOT'){
    const baseConf=(v)=>{
      if(v===null||v==='')return 'TO_VERIFY';
      if(p.ocrConfidence!==null && p.ocrConfidence<80)return 'TO_VERIFY';
      return 'ESTIMATED';
    };
    const u=p.unit?` (${p.unit})`:'';
    $('captureProposal').innerHTML=
      captureField('Paire','pair',p.pair,baseConf(p.pair))+
      captureField('Investissement'+u,'investment',p.investment,baseConf(p.investment))+
      captureField('Bénéfice courant'+u,'currentProfit',p.currentProfit,baseConf(p.currentProfit))+
      captureField('Grid Profit'+u,'grid',p.grid,baseConf(p.grid))+
      captureField('P&L latent'+u,'latent',p.latent,baseConf(p.latent))+
      captureField('Valeur actuelle'+u,'currentValue',p.currentValue,p.currentValueConfidence)+
      captureField('Retiré'+u,'withdrawn',p.withdrawn,baseConf(p.withdrawn));
    const note=$('captureAccountingNote');
    if(p.unit && p.unit!=='EUR'){
      note.hidden=false;
      note.innerHTML=`Cette capture est en <b>${escapeHtml(p.unit)}</b>. GridLedger peut enregistrer les métriques natives, mais ne les convertira pas automatiquement en EUR et ne modifiera pas la valeur patrimoniale sans valorisation EUR fiable.`;
    }else{
      note.hidden=true;note.textContent='';
    }
    const bots=currentState.bots||[];
    $('captureBotTarget').innerHTML=bots.map(b=>`<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    $('captureDate').value=new Date().toISOString().slice(0,10);
    $('captureBotSaveArea').hidden=!bots.length;
    document.querySelectorAll('[data-reread-field]').forEach(btn=>{
      btn.addEventListener('click',()=>rereadProposalField(btn.dataset.rereadField));
    });
    document.querySelectorAll('[data-pointer-field]').forEach(btn=>{
      btn.addEventListener('click',()=>openPointerOCR(btn.dataset.pointerField));
    });
    document.querySelectorAll('[data-confirm-field]').forEach(btn=>{
      btn.addEventListener('click',()=>confirmProposalField(btn.dataset.confirmField));
    });
    document.querySelectorAll('[data-proposal-value]').forEach(inp=>{
      inp.addEventListener('input',()=>onProposalValueEdited(inp.dataset.proposalValue));
    });
    document.querySelectorAll('[data-proposal-conf]').forEach(sel=>sel.addEventListener('change',()=>{
      refreshProposalRow(sel.dataset.proposalConf);
      updateVerificationCount();
    }));
    updateVerificationCount();
  }else{
    $('captureProposal').innerHTML='<div class="muted">La sauvegarde structurée de ce type sera ajoutée après le parcours Bot. Le texte OCR reste disponible et modifiable.</div>';
    $('captureBotSaveArea').hidden=true;
  }
}
function proposalValue(key){
  const el=document.querySelector(`[data-proposal-value="${key}"]`);
  return el?el.value:'';
}
function proposalConf(key){
  const el=document.querySelector(`[data-proposal-conf="${key}"]`);
  return el?el.value:'TO_VERIFY';
}
function aggregateProposalConfidence(keys){
  const vals=keys.map(proposalConf);
  if(vals.includes('TO_VERIFY'))return 'TO_VERIFY';
  if(vals.includes('ESTIMATED'))return 'ESTIMATED';
  return 'CERTAIN';
}
async function ensureTesseract(){
  if(window.Tesseract)return;
  $('ocrStatus').className='ocrStatus busy';
  $('ocrStatus').textContent='Chargement du moteur OCR local…';
  await new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload=resolve;s.onerror=()=>reject(new Error('Moteur OCR indisponible'));
    document.head.appendChild(s);
  });
}
function updateOCRProgress(m){
  if(!m)return;
  const pct=typeof m.progress==='number'?Math.round(m.progress*100):null;
  const labels={
    'loading tesseract core':'Chargement du moteur',
    'initializing tesseract':'Initialisation',
    'loading language traineddata':'Chargement des langues',
    'initializing api':'Préparation OCR',
    'recognizing text':'Lecture de l’image'
  };
  const label=labels[m.status]||m.status||'OCR';
  $('ocrStatus').className='ocrStatus busy';
  $('ocrStatus').innerHTML=`${escapeHtml(label)}${pct!==null?' · '+pct+' %':''}<div class="ocrProgress"><i style="width:${pct||0}%"></i></div>`;
}

async function cropImageBlob(file, xRatio, yRatio, wRatio, hRatio, scale=2){
  const bmp=await createImageBitmap(file);
  const sx=Math.max(0,Math.round(bmp.width*xRatio));
  const sy=Math.max(0,Math.round(bmp.height*yRatio));
  const sw=Math.min(bmp.width-sx,Math.round(bmp.width*wRatio));
  const sh=Math.min(bmp.height-sy,Math.round(bmp.height*hRatio));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(sw*scale));
  canvas.height=Math.max(1,Math.round(sh*scale));
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bmp,sx,sy,sw,sh,0,0,canvas.width,canvas.height);

  const img=ctx.getImageData(0,0,canvas.width,canvas.height),d=img.data;
  let lum=0,samples=0;
  for(let i=0;i<d.length;i+=40){
    lum+=d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722;
    samples++;
  }
  const avg=lum/Math.max(samples,1),invert=avg<120;
  for(let i=0;i<d.length;i+=4){
    let g=d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722;
    if(invert)g=255-g;
    g=Math.max(0,Math.min(255,(g-128)*1.65+128));
    d[i]=d[i+1]=d[i+2]=g;
  }
  ctx.putImageData(img,0,0);
  return new Promise(resolve=>canvas.toBlob(resolve,'image/png',1));
}
function mergeOCRTexts(...texts){
  const seen=new Set(),out=[];
  for(const text of texts){
    for(const raw of String(text||'').split(/\n+/)){
      const line=raw.trim();
      if(!line)continue;
      const key=line.toLowerCase().replace(/\s+/g,' ');
      if(!seen.has(key)){seen.add(key);out.push(line);}
    }
  }
  return out.join('\n');
}
async function runTargetedPionexOCR(worker,file,baseText){
  // Generic portrait-screen zones where Pionex bot metrics usually live.
  const zones=[
    [0.08,0.30,0.84,0.28,2.2], // bot title + investment/current profit
    [0.08,0.48,0.84,0.24,2.4], // grid profit + trend pnl + APR
    [0.08,0.63,0.84,0.22,2.3]  // range/price/withdrawn
  ];
  let merged=baseText||'';
  for(let i=0;i<zones.length;i++){
    try{
      $('ocrStatus').className='ocrStatus busy';
      $('ocrStatus').textContent=`Profil Pionex : lecture ciblée ${i+1}/${zones.length}…`;
      const crop=await cropImageBlob(file,...zones[i]);
      const r=await worker.recognize(crop);
      merged=mergeOCRTexts(merged,r?.data?.text||'');
    }catch(e){}
  }
  return merged;
}

const PIONEX_FIELD_ZONES={
  pair:[0.16,0.30,0.70,0.11,2.6],
  investment:[0.10,0.39,0.42,0.12,2.8],
  currentProfit:[0.48,0.39,0.42,0.12,2.8],
  grid:[0.10,0.49,0.42,0.13,3.0],
  latent:[0.48,0.49,0.42,0.13,3.0],
  withdrawn:[0.10,0.66,0.40,0.15,2.8]
};

// Tighter value-only areas used when the normal targeted OCR sees the right block
// but misses the number because neighbouring labels interfere.
const PIONEX_NUMERIC_ZONES={
  investment:[0.12,0.435,0.34,0.065,3.2],
  currentProfit:[0.54,0.435,0.34,0.065,3.4],
  grid:[0.12,0.535,0.34,0.060,3.4],
  latent:[0.54,0.535,0.34,0.060,3.4],
  withdrawn:[0.12,0.695,0.32,0.060,3.2]
};

function fieldLabel(key){
  return {
    pair:'Paire',investment:'Investissement',currentProfit:'Bénéfice courant',
    grid:'Grid Profit',latent:'P&L latent',currentValue:'Valeur actuelle',withdrawn:'Retiré'
  }[key]||key;
}

function refreshProposalRow(key){
  const conf=document.querySelector(`[data-proposal-conf="${key}"]`);
  const input=document.querySelector(`[data-proposal-value="${key}"]`);
  if(!conf)return;

  const row=conf.closest('.proposalField');
  row?.classList.remove('confCertain','confEstimated','confVerify');
  row?.classList.add(conf.value==='CERTAIN'?'confCertain':conf.value==='ESTIMATED'?'confEstimated':'confVerify');

  const hasValue=!!String(input?.value||'').trim();
  if(row){
    row.dataset.hasValue=hasValue?'1':'0';
    row.dataset.confirmed=conf.value==='CERTAIN'?'1':'0';
  }

  const simple=document.querySelector(`[data-simple-status="${key}"]`);
  if(simple){
    const statusClass=conf.value==='CERTAIN'?'certain':conf.value==='ESTIMATED'?'estimated':'verify';
    simple.className='simpleStatus '+statusClass;
    simple.textContent=conf.value==='CERTAIN'?'Certain':conf.value==='ESTIMATED'?'Estimé':'À vérifier';
  }
}
function onProposalValueEdited(key){
  const input=document.querySelector(`[data-proposal-value="${key}"]`);
  const conf=document.querySelector(`[data-proposal-conf="${key}"]`);
  if(!input||!conf)return;

  if(String(input.value||'').trim() && conf.value==='CERTAIN'){
    conf.value='ESTIMATED';
  }
  refreshProposalRow(key);
  updateVerificationCount();
}
function confirmProposalField(key){
  const input=document.querySelector(`[data-proposal-value="${key}"]`);
  const conf=document.querySelector(`[data-proposal-conf="${key}"]`);
  if(!input||!conf)return;
  if(!String(input.value||'').trim())return alert('Aucune valeur à confirmer.');
  conf.value='CERTAIN';
  refreshProposalRow(key);
  updateVerificationCount();
  const inline=document.querySelector(`[data-inline-debug="${key}"]`);
  if(inline){
    inline.hidden=false;
    inline.innerHTML += `\n\n<b>Validation humaine :</b> valeur confirmée visuellement.`;
  }
}
function updateVerificationCount(){
  const fields=[...document.querySelectorAll('[data-proposal-conf]')];
  const count=fields.filter(x=>x.value!=='CERTAIN').length;
  const el=$('verificationCount');
  if(el)el.textContent=`${count} champ${count>1?'s':''} à vérifier`;
}
function parseFieldFromText(key,text){
  const t=String(text||'');
  if(key==='pair'){
    const m=t.match(/\b([A-Z0-9]{2,12})\s*\/\s*([A-Z0-9]{2,12})\b/i);
    return m?(m[1]+'/'+m[2]).toUpperCase():'';
  }
  const patterns={
    investment:[
      /Investissement(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
      /Investment\s*Amount[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
    ],
    currentProfit:[
      /B[ée]n[ée]fice\s*(?:courant|c0urant|couran[tf])(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
      /Current\s*Profit[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
    ],
    grid:[
      /Grid\s*profit(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
    ],
    latent:[
      /P[nmN][LlI]\s*(?:de\s*)?tendance(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
      /Unrealized\s*(?:P&L|PnL)[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
    ],
    currentValue:[
      /Valeur\s*actuelle[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
      /Current\s*Value[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
    ],
    withdrawn:[
      /Retir[ée]?(?:\s+[A-Z]{2,8})?[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i,
      /Withdrawn[^+\-\d]*([+\-]?\s*[\d\s.,]+)/i
    ]
  }[key]||[];
  return extractByPatterns(t,patterns);
}
async function getOCRWorker(){
  await ensureTesseract();
  if(tesseractWorker)return tesseractWorker;
  tesseractWorker=await Tesseract.createWorker(['fra','eng'],1,{
    workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
    langPath:'https://tessdata.projectnaptha.com/4.0.0_fast',
    corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.0.0',
    logger:updateOCRProgress
  });
  return tesseractWorker;
}

async function rereadNumericOnly(worker,key){
  const zone=PIONEX_NUMERIC_ZONES[key];
  if(!zone)return {value:null,raw:'',crop:null};
  const crop=await cropImageBlob(currentCaptureFile,...zone);

  // Restrict OCR to characters that can form a monetary/percentage value.
  try{
    await worker.setParameters({
      tessedit_pageseg_mode:'7',
      tessedit_char_whitelist:'0123456789+-,.%'
    });
  }catch(e){}

  const ret=await worker.recognize(crop);
  const raw=(ret?.data?.text||'').trim();

  const matches=[...raw.matchAll(/[+\-]?\s*\d(?:[\d\s.,]*\d)?/g)]
    .map(m=>({raw:m[0],value:parseLocalizedNumber(m[0])}))
    .filter(x=>x.value!==null);

  let value=null;
  if(matches.length){
    matches.sort((a,b)=>{
      const score=x=>{
        let s=0;
        if(/[.,]/.test(x.raw))s+=5;
        if(/[+\-]/.test(x.raw))s+=3;
        s+=(x.raw.match(/\d/g)||[]).length;
        return s;
      };
      return score(b)-score(a);
    });
    value=matches[0].value;
  }

  return {value,raw,crop};
}

function openPointerOCR(key){
  if(!currentCaptureData||!currentCaptureFile)return alert('Recharge d’abord la capture.');
  pointerFieldKey=key;
  $('pointerOCRTitle').textContent=`Pointer : ${fieldLabel(key)}`;
  $('pointerOCRImage').src=currentCaptureData;
  $('pointerCrosshair').hidden=true;
  $('pointerOCRStatus').className='pointerStatus';
  $('pointerOCRStatus').textContent='Touche directement le nombre à lire.';
  $('pointerManualValue').value='';
  $('pointerOCRModal').hidden=false;
}
function closePointerOCR(){
  $('pointerOCRModal').hidden=true;
  pointerFieldKey=null;
}
async function cropAroundPoint(file,xRatio,yRatio,wRatio=0.34,hRatio=0.075,scale=4){
  const bmp=await createImageBitmap(file);
  const sw=Math.max(40,Math.round(bmp.width*wRatio));
  const sh=Math.max(24,Math.round(bmp.height*hRatio));
  let sx=Math.round(bmp.width*xRatio-sw/2);
  let sy=Math.round(bmp.height*yRatio-sh/2);
  sx=Math.max(0,Math.min(bmp.width-sw,sx));
  sy=Math.max(0,Math.min(bmp.height-sh,sy));

  const canvas=document.createElement('canvas');
  canvas.width=Math.round(sw*scale);
  canvas.height=Math.round(sh*scale);
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bmp,sx,sy,sw,sh,0,0,canvas.width,canvas.height);

  return new Promise(resolve=>canvas.toBlob(resolve,'image/png',1));
}
async function preprocessNumericBlob(blob,mode){
  const bmp=await createImageBitmap(blob);
  const canvas=document.createElement('canvas');
  canvas.width=bmp.width;canvas.height=bmp.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bmp,0,0);
  const img=ctx.getImageData(0,0,canvas.width,canvas.height),d=img.data;

  let avg=0;
  for(let i=0;i<d.length;i+=40)avg+=d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722;
  avg/=Math.max(1,Math.ceil(d.length/40));

  for(let i=0;i<d.length;i+=4){
    let g=d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722;
    if(mode==='invert')g=255-g;
    else if(mode==='auto' && avg<125)g=255-g;

    if(mode==='threshold'){
      if(avg<125)g=255-g;
      g=g>145?255:0;
    }else{
      g=Math.max(0,Math.min(255,(g-128)*1.8+128));
    }
    d[i]=d[i+1]=d[i+2]=g;
  }
  ctx.putImageData(img,0,0);
  return new Promise(resolve=>canvas.toBlob(resolve,'image/png',1));
}
function numericCandidates(raw){
  return [...String(raw||'').matchAll(/[+\-]?\s*\d(?:[\d\s.,]*\d)?/g)]
    .map(m=>({raw:m[0].trim(),value:parseLocalizedNumber(m[0])}))
    .filter(x=>x.value!==null);
}
function bestNumericCandidate(all){
  if(!all.length)return null;
  const unique=[];
  const seen=new Set();
  for(const x of all){
    const key=String(x.value);
    if(!seen.has(key)){seen.add(key);unique.push(x);}
  }
  unique.sort((a,b)=>{
    const score=x=>{
      let s=0;
      if(/[.,]/.test(x.raw))s+=6;
      if(/^[+\-]/.test(x.raw))s+=3;
      const digits=(x.raw.match(/\d/g)||[]).length;
      s+=Math.min(8,digits);
      if(digits<2)s-=5;
      return s;
    };
    return score(b)-score(a);
  });
  return unique[0];
}

function isSafeOCRNumericCandidate(candidate, key, rawCombined){
  if(!candidate)return false;
  const raw=String(candidate.raw||'').trim();
  const value=Number(candidate.value);
  if(!Number.isFinite(value))return false;

  // For Pionex monetary metrics, a punctuation-free long digit string is unsafe:
  // e.g. "+39,49 (+3,73%)" can be misread as "3949037".
  const monetaryKeys=['investment','currentProfit','grid','latent','withdrawn','currentValue'];
  if(monetaryKeys.includes(key)){
    const digits=(raw.match(/\d/g)||[]).length;
    const hasDecimal=/[.,]/.test(raw);
    const hasSign=/^[+\-]/.test(raw);

    // Reject concatenated-looking results.
    if(!hasDecimal && digits>=4)return false;

    // Multiple numeric groups in the raw OCR but one flattened result => ambiguous.
    const groups=(String(rawCombined||'').match(/[+\-]?\d+(?:[.,]\d+)?/g)||[]);
    if(groups.length>=2 && !hasDecimal)return false;

    // Extremely large values from a tiny metric crop are suspicious unless punctuation survived.
    if(Math.abs(value)>=100000 && !hasDecimal)return false;

    // A percentage sign in the same crop can cause amount+percentage concatenation.
    if(/%/.test(String(rawCombined||'')) && !hasDecimal)return false;
  }

  return true;
}
function applyEstimatedPointerValue(key,value,sourceLabel='Saisie assistée'){
  const input=document.querySelector(`[data-proposal-value="${key}"]`);
  const conf=document.querySelector(`[data-proposal-conf="${key}"]`);
  if(!input||!conf)return false;

  input.value=value;
  conf.value='ESTIMATED';
  refreshProposalRow(key);
  updateVerificationCount();

  const inline=document.querySelector(`[data-inline-debug="${key}"]`);
  if(inline){
    inline.hidden=false;
    inline.innerHTML += `\n\n<b>${escapeHtml(sourceLabel)} :</b> ${escapeHtml(value)}`;
  }
  return true;
}
function usePointerManualValue(){
  if(!pointerFieldKey)return;
  const raw=$('pointerManualValue').value.trim();
  const value=parseLocalizedNumber(raw);
  if(value===null){
    alert('Saisis un nombre valide, par exemple 39,49.');
    return;
  }
  const key=pointerFieldKey;
  applyEstimatedPointerValue(key,value,'Valeur saisie sous contrôle visuel');
  $('pointerOCRStatus').className='pointerStatus ok';
  $('pointerOCRStatus').textContent=`Valeur saisie : ${value}. Vérifie-la puis utilise « J’ai vérifié ».`;
  setTimeout(closePointerOCR,700);
}
async function pointerOCRAt(ev){
  if(!pointerFieldKey||!currentCaptureFile)return;
  const img=$('pointerOCRImage'),rect=img.getBoundingClientRect();
  const x=Math.max(0,Math.min(1,(ev.clientX-rect.left)/rect.width));
  const y=Math.max(0,Math.min(1,(ev.clientY-rect.top)/rect.height));

  const cross=$('pointerCrosshair');
  cross.style.left=(x*100)+'%';cross.style.top=(y*100)+'%';cross.hidden=false;

  $('pointerOCRStatus').className='pointerStatus';
  $('pointerOCRStatus').textContent='Lecture locale autour du point choisi…';

  try{
    const worker=await getOCRWorker();
    try{
      await worker.setParameters({
        tessedit_pageseg_mode:'7',
        tessedit_char_whitelist:'0123456789+-,.%()'
      });
    }catch(e){}

    // Try several crop heights/widths and image preprocessings around the finger.
    const crops=[
      await cropAroundPoint(currentCaptureFile,x,y,0.36,0.075,4),
      await cropAroundPoint(currentCaptureFile,x,y,0.30,0.060,5),
      await cropAroundPoint(currentCaptureFile,x,y,0.42,0.095,3.5)
    ];

    const candidates=[];
    const rawLogs=[];
    for(const crop of crops){
      for(const mode of ['auto','threshold']){
        const processed=await preprocessNumericBlob(crop,mode);
        const ret=await worker.recognize(processed);
        const raw=(ret?.data?.text||'').trim();
        if(raw)rawLogs.push(raw);
        candidates.push(...numericCandidates(raw));
      }
    }

    const best=bestNumericCandidate(candidates);
    const key=pointerFieldKey;
    const combinedRaw=rawLogs.join(' | ');
    const safeBest=isSafeOCRNumericCandidate(best,key,combinedRaw);
    const inline=document.querySelector(`[data-inline-debug="${key}"]`);

    if(inline){
      inline.hidden=false;
      inline.innerHTML=`<b>Dernière lecture après pointage :</b>\n${escapeHtml(combinedRaw||'(aucun nombre lu)')}`;
      if(best && safeBest){
        inline.innerHTML+=`\n\n<b>Valeur OCR proposée :</b> ${escapeHtml(best.value)}`;
      }else if(best && !safeBest){
        inline.innerHTML+=`\n\n<b>Lecture rejetée par sécurité :</b> ${escapeHtml(best.raw)} → ${escapeHtml(best.value)}`;
        inline.innerHTML+=`\nLe format est ambigu ; GridLedger ne remplit pas le champ automatiquement.`;
      }else{
        const existing=document.querySelector(`[data-proposal-value="${key}"]`)?.value;
        if(String(existing||'').trim()){
          inline.innerHTML+=`\n\n<b>Valeur précédente conservée :</b> ${escapeHtml(existing)}.`;
        }
      }
    }

    if(best && safeBest){
      applyEstimatedPointerValue(key,best.value,'Valeur OCR proposée');
      $('pointerOCRStatus').className='pointerStatus ok';
      $('pointerOCRStatus').textContent=`Valeur OCR proposée : ${best.value}. Vérifie-la avant validation.`;
      setTimeout(closePointerOCR,900);
    }else{
      $('pointerOCRStatus').className='pointerStatus bad';
      $('pointerOCRStatus').textContent=best
        ?'Lecture ambiguë rejetée. Saisis la valeur visible dans le champ ci-dessous.'
        :'Aucun nombre fiable. Saisis la valeur visible dans le champ ci-dessous.';
      $('pointerManualValue').focus();
    }

    try{
      await worker.setParameters({tessedit_pageseg_mode:'6',tessedit_char_whitelist:''});
    }catch(e){}
  }catch(e){
    $('pointerOCRStatus').className='pointerStatus bad';
    $('pointerOCRStatus').textContent='Lecture impossible. Réessaie ou saisis la valeur manuellement.';
  }
}
async function rereadProposalField(key){
  if(!currentCaptureFile)return alert('Recharge d’abord la capture.');
  const source=captureParsed?.source||detectCaptureSource($('captureText').value);
  if(source!=='Pionex' || !PIONEX_FIELD_ZONES[key]){
    alert('La relecture ciblée de ce champ est disponible pour le profil Pionex dans cette version.');
    return;
  }

  const btn=document.querySelector(`[data-reread-field="${key}"]`);
  const inline=document.querySelector(`[data-inline-debug="${key}"]`);
  const actions=document.querySelector(`[data-inline-actions="${key}"]`);
  if(btn)btn.disabled=true;

  try{
    const worker=await getOCRWorker();

    // Pass 1: normal targeted zone with labels + value.
    try{
      await worker.setParameters({
        tessedit_pageseg_mode:'6',
        tessedit_char_whitelist:''
      });
    }catch(e){}

    $('ocrStatus').className='ocrStatus busy';
    $('ocrStatus').textContent=`Relecture ciblée : ${fieldLabel(key)}…`;

    const crop=await cropImageBlob(currentCaptureFile,...PIONEX_FIELD_ZONES[key]);
    let displayCropUrl=URL.createObjectURL(crop);

    const ret=await worker.recognize(crop);
    const raw=(ret?.data?.text||'').trim();

    let value=parseFieldFromText(key,raw);
    let numericRaw='';
    let usedNumericPass=false;
    let numericCrop=null;

    // Pass 2: if the normal zone failed, read only the number in a much tighter area.
    if((value===null||value==='') && key!=='pair' && PIONEX_NUMERIC_ZONES[key]){
      $('ocrStatus').className='ocrStatus busy';
      $('ocrStatus').textContent=`${fieldLabel(key)} : lecture du nombre uniquement…`;

      const numeric=await rereadNumericOnly(worker,key);
      numericRaw=numeric.raw||'';
      numericCrop=numeric.crop;
      if(numeric.value!==null){
        value=numeric.value;
        usedNumericPass=true;
        if(numericCrop)displayCropUrl=URL.createObjectURL(numericCrop);
      }
    }

    // Generic numeric fallback on the larger crop.
    if((value===null||value==='') && key!=='pair'){
      const matches=[...raw.matchAll(/[+\-]?\s*\d(?:[\d\s.,]*\d)?/g)]
        .map(m=>({raw:m[0],value:parseLocalizedNumber(m[0])}))
        .filter(x=>x.value!==null);

      if(matches.length===1)value=matches[0].value;
    }

    if((value===null||value==='') && key==='pair'){
      const pm=raw.match(/([A-Z0-9]{2,12})\s*[/|\\]\s*([A-Z0-9]{2,12})/i);
      if(pm)value=(pm[1]+'/'+pm[2]).toUpperCase();
    }

    if(actions){
      actions.hidden=false;
      const viewBtn=actions.querySelector(`[data-view-zone="${key}"]`);
      if(viewBtn){
        viewBtn.hidden=false;
        viewBtn.textContent=usedNumericPass?'Voir la zone nombre':'Voir la zone lue';
        viewBtn.onclick=()=>{
          $('captureZoomImage').src=displayCropUrl;
          $('captureZoomModal').hidden=false;
        };
      }
    }

    if(inline){
      inline.hidden=false;
      inline.innerHTML=`<b>Texte OCR de la zone :</b>\n${escapeHtml(raw||'(aucun texte détecté)')}`;
      if(PIONEX_NUMERIC_ZONES[key] && key!=='pair'){
        inline.innerHTML+=`\n\n<b>Lecture nombre uniquement :</b>\n${escapeHtml(numericRaw||'(aucun nombre détecté)')}`;
      }
      if(value!==null && value!==''){
        inline.innerHTML+=`\n\n<b>Valeur proposée :</b> ${escapeHtml(value)}`;
      }
    }

    const input=document.querySelector(`[data-proposal-value="${key}"]`);
    const conf=document.querySelector(`[data-proposal-conf="${key}"]`);

    if(value!==null && value!==''){
      input.value=value;
      conf.value='ESTIMATED';
      const row=conf.closest('.proposalField');
      refreshProposalRow(key);

      $('ocrStatus').className='ocrStatus ok';
      $('ocrStatus').textContent=`${fieldLabel(key)} relu${usedNumericPass?' avec la lecture nombre uniquement':''}. Compare la valeur proposée avec la capture.`;
    }else{
      $('ocrStatus').className='ocrStatus bad';
      $('ocrStatus').textContent=`Aucune valeur exploitable trouvée pour ${fieldLabel(key)}. La zone et les deux lectures sont visibles sous le champ.`;
    }

    updateVerificationCount();

    // Restore normal OCR parameters for later operations.
    try{
      await worker.setParameters({
        tessedit_pageseg_mode:'6',
        tessedit_char_whitelist:''
      });
    }catch(e){}
  }catch(e){
    if(inline){
      inline.hidden=false;
      inline.innerHTML=`<b>Erreur OCR :</b> ${escapeHtml(e?.message||String(e))}`;
    }
    $('ocrStatus').className='ocrStatus bad';
    $('ocrStatus').textContent=`Relecture impossible pour ${fieldLabel(key)}.`;
  }finally{
    if(btn)btn.disabled=false;
  }
}
async function rereadMissingFields(){
  const fields=[...document.querySelectorAll('[data-proposal-conf]')]
    .filter(x=>x.value==='TO_VERIFY')
    .map(x=>x.dataset.proposalConf)
    .filter(k=>PIONEX_FIELD_ZONES[k]);
  if(!fields.length){
    alert('Aucun champ Pionex relisible automatiquement.');
    return;
  }
  $('rereadMissingBtn').disabled=true;
  for(const key of fields)await rereadProposalField(key);
  try{if(tesseractWorker){await tesseractWorker.terminate();tesseractWorker=null}}catch(e){}
  $('rereadMissingBtn').disabled=false;
}
async function preprocessImageForOCR(file){
  const bmp=await createImageBitmap(file);
  const scale=Math.min(2,Math.max(1,1400/bmp.width));
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(bmp.width*scale);canvas.height=Math.round(bmp.height*scale);
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bmp,0,0,canvas.width,canvas.height);
  const img=ctx.getImageData(0,0,canvas.width,canvas.height),d=img.data;
  let lum=0;const step=Math.max(4,Math.floor(d.length/40000/4)*4);
  for(let i=0;i<d.length;i+=step)lum+=(d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722);
  const samples=Math.ceil(d.length/step),avg=lum/Math.max(samples,1),invert=avg<115;
  for(let i=0;i<d.length;i+=4){
    let g=Math.round(d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722);
    if(invert)g=255-g;
    // gentle contrast, not hard threshold
    g=Math.max(0,Math.min(255,(g-128)*1.45+128));
    d[i]=d[i+1]=d[i+2]=g;
  }
  ctx.putImageData(img,0,0);
  return new Promise(resolve=>canvas.toBlob(resolve,'image/png',1));
}
async function runCaptureOCR(){
  if(!currentCaptureFile)return alert('Choisis d’abord une image ou prends une photo.');
  $('captureOCR').disabled=true;
  try{
    captureOCRConfidence=null;
    if('TextDetector' in window){
      try{
        $('ocrStatus').className='ocrStatus busy';
        $('ocrStatus').textContent='Lecture avec le moteur OCR du téléphone…';
        const bitmap=await createImageBitmap(currentCaptureFile);
        const detector=new TextDetector();
        const blocks=await detector.detect(bitmap);
        const text=blocks.map(x=>x.rawValue||'').join('\n');
        if(text.trim()){
          $('captureText').value=text;
          $('ocrStatus').className='ocrStatus ok';
          $('ocrStatus').textContent='Texte lu localement avec le moteur du téléphone.';
          analyzeCapture();return;
        }
      }catch(e){}
    }
    await ensureTesseract();
    $('ocrStatus').className='ocrStatus busy';
    $('ocrStatus').textContent='Initialisation de l’OCR local…';
    tesseractWorker=await Tesseract.createWorker(['fra','eng'],1,{
      workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
      langPath:'https://tessdata.projectnaptha.com/4.0.0_fast',
      corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.0.0',
      logger:updateOCRProgress
    });
    let ret=await tesseractWorker.recognize(currentCaptureFile);
    let best=ret;
    if((ret?.data?.confidence??0)<82){
      try{
        $('ocrStatus').className='ocrStatus busy';
        $('ocrStatus').textContent='OCR renforcé : amélioration du contraste…';
        const enhanced=await preprocessImageForOCR(currentCaptureFile);
        if(enhanced){
          const ret2=await tesseractWorker.recognize(enhanced);
          if((ret2?.data?.confidence??0)>(best?.data?.confidence??0))best=ret2;
        }
      }catch(e){}
    }
    captureOCRConfidence=best?.data?.confidence??null;
    let finalText=best?.data?.text||'';

    // If Pionex is identifiable from the full OCR, perform extra targeted passes
    // on the metric zones and merge unique text lines.
    const detectedAfterFull=detectCaptureSource(finalText);
    if(detectedAfterFull==='Pionex'){
      try{
        finalText=await runTargetedPionexOCR(tesseractWorker,currentCaptureFile,finalText);
      }catch(e){}
    }

    $('captureText').value=finalText;
    await tesseractWorker.terminate();tesseractWorker=null;
    $('ocrStatus').className='ocrStatus ok';
    $('ocrStatus').textContent=`Lecture terminée. Vérifie les champs proposés avant enregistrement.`;
    analyzeCapture();
  }catch(e){
    try{if(tesseractWorker)await tesseractWorker.terminate()}catch{}
    tesseractWorker=null;
    $('ocrStatus').className='ocrStatus bad';
    $('ocrStatus').textContent='OCR impossible sur ce navigateur/réseau. Tu peux toujours coller ou corriger le texte manuellement.';
  }finally{
    $('captureOCR').disabled=false;
  }
}
async function storeCaptureAsEncryptedDocument(botId,date){
  if(!currentCaptureFile)return null;
  const bot=currentState.bots.find(b=>b.id===botId);

  const existingDocs=await getDocMetas();
  const same=existingDocs.find(d=>
    d.entity===`BOT:${botId}` &&
    d.category==='BOT' &&
    Number(d.size||0)===Number(currentCaptureFile.size||0) &&
    String(d.fileName||'')===String(currentCaptureFile.name||'') &&
    String(d.createdAt||'').slice(0,10)===String(date||'')
  );
  if(same){
    const keep=confirm('Un justificatif très similaire existe déjà pour ce bot et cette date. Créer une deuxième copie ?');
    if(!keep)return same.id;
  }

  const id=uid();
  const meta={
    id,fileName:currentCaptureFile.name||`capture-${date}.jpg`,
    title:`Capture bot · ${bot?.name||'Bot'} · ${date}`,
    year:Number(date.slice(0,4))||new Date().getFullYear(),
    category:'BOT',entity:'BOT:'+botId,note:'Capture source du snapshot GridLedger',
    includeTax:false,confidence:aggregateProposalConfidence(['pair','currentValue','grid','latent']),
    mime:currentCaptureFile.type||'image/jpeg',size:currentCaptureFile.size||0,createdAt:new Date().toISOString(),
    sourceApp:$('captureSource').value.trim()||captureParsed?.source||'Autre'
  };
  const metaEnc=await encryptJSON(meta);
  const fileEnc=await encryptBytes(await currentCaptureFile.arrayBuffer());
  await dbPut({id:'docmeta:'+id,type:'docmeta',iv:metaEnc.iv,data:metaEnc.data});
  await dbPut({id:'docfile:'+id,type:'docfile',iv:fileEnc.iv,data:fileEnc.data});
  return id;
}
async function saveCaptureBotSnapshot(){
  if(!captureParsed||captureParsed.kind!=='BOT')return;
  const botId=$('captureBotTarget').value;
  const bot=currentState.bots.find(b=>b.id===botId);
  if(!bot)return alert('Choisis un bot.');

  const date=$('captureDate').value||new Date().toISOString().slice(0,10);
  const currentValue=parseLocalizedNumber(proposalValue('currentValue'));
  const grid=parseLocalizedNumber(proposalValue('grid'));
  const latent=parseLocalizedNumber(proposalValue('latent'));
  const investment=parseLocalizedNumber(proposalValue('investment'));
  const currentProfit=parseLocalizedNumber(proposalValue('currentProfit'));
  const withdrawn=parseLocalizedNumber(proposalValue('withdrawn'));
  const pair=proposalValue('pair').trim();
  const unit=(captureParsed.unit||detectQuoteUnit($('captureText').value,pair)||'').toUpperCase();

  const meaningful=[currentValue,grid,latent,investment,currentProfit,withdrawn].some(v=>v!==null);
  if(!meaningful)return alert('Aucune métrique exploitable à enregistrer.');
  if(pair && proposalConf('pair')==='TO_VERIFY'){
    return alert('Vérifie la paire et passe-la sur Estimé ou Certain, ou efface-la si elle est incorrecte.');
  }

  for(const key of ['grid','latent','investment','currentProfit','withdrawn']){
    const val=parseLocalizedNumber(proposalValue(key));
    if(val!==null && proposalConf(key)==='TO_VERIFY'){
      return alert(`${fieldLabel(key)} contient une valeur mais reste « À vérifier ». Vérifie-la puis choisis Estimé ou Certain avant l’enregistrement.`);
    }
  }

  const confidence=aggregateProposalConfidence(['pair','currentValue','grid','latent']);
  let documentId=null;
  if($('captureKeepImage').checked)documentId=await storeCaptureAsEncryptedDocument(botId,date);

  const valuationStatus=(unit==='EUR' && currentValue!==null && proposalConf('currentValue')!=='TO_VERIFY')?'VALUED_EUR':'PARTIAL_NATIVE';
  currentState.snapshots=currentState.snapshots||[];
  const candidateSnapshot={
    id:uid(),botId,date,capturedAt:nowIso(),
    nativeValue:currentValue,nativeUnit:unit,
    gridProfitNative:grid,latentNative:latent,investmentAmountNative:investment,currentProfitNative:currentProfit,withdrawnNative:withdrawn,
    pair,sourceType:'SCREENSHOT',sourceApp:$('captureSource').value.trim()||captureParsed.source,
    confidence,ocrConfidence:captureOCRConfidence,documentId,valuationStatus
  };

  const duplicateSnapshot=(currentState.snapshots||[]).find(s=>sameSnapshotMetrics(s,candidateSnapshot));
  if(duplicateSnapshot){
    const proceed=confirm('Un snapshot identique existe déjà pour ce bot à cette date. Enregistrer quand même ?');
    if(!proceed){
      if(documentId){
        await dbDelete('docmeta:'+documentId);
        await dbDelete('docfile:'+documentId);
      }
      $('captureResult').innerHTML='<b>Doublon évité.</b><p class="muted">Aucun nouveau snapshot n’a été ajouté.</p>';
      return;
    }
  }

  currentState.snapshots.push(candidateSnapshot);

  // Only authoritative EUR valuation is allowed to alter the patrimonial balance.
  if(valuationStatus==='VALUED_EUR'){
    bot.value=currentValue;
    const loc=currentState.locations.find(l=>l.id===bot.locationId);if(loc)loc.balance=currentValue;
  }
  // Platform metrics can be shown as native metrics without changing global EUR performance.
  const detectedPlatform=($('captureSource').value.trim()||captureParsed.source||'').trim();
  bot.lastNativeSnapshot={
    date,unit,grid,latent,currentValue,valuationStatus,
    sourceApp:detectedPlatform||'Autre'
  };
  if(pair)bot.pair=pair;

  // A capture may safely replace a blank/demo platform, but never overwrite
  // an already configured real platform automatically.
  if(detectedPlatform && detectedPlatform!=='Autre'){
    const currentPlatform=String(bot.platform||'').trim();
    if(!currentPlatform || /^exemple$/i.test(currentPlatform)){
      bot.platform=detectedPlatform;
    }
  }

  await saveState();
  renderAll();
  if(documentId)await renderDocCounts();

  $('captureResult').innerHTML=`<b>Snapshot enregistré.</b><p class="muted">${valuationStatus==='VALUED_EUR'?'La valeur EUR validée a été appliquée au capital financier.':'Les métriques natives ont été conservées sans modifier la valeur financière en EUR.'}${documentId?' La capture est archivée dans le coffre chiffré.':''}</p>`;
  $('captureProposalPanel').hidden=true;
  currentCaptureData=null;currentCaptureFile=null;captureParsed=null;captureOCRConfidence=null;
  $('captureText').value='';$('capturePreview').innerHTML='Aucune image';$('zoomCaptureBtn').hidden=true;if($('shareCaptureAssistant'))$('shareCaptureAssistant').hidden=true;
  $('captureGalleryInput').value='';$('captureCameraInput').value='';
  $('captureKeepImage').checked=false;
}

function exportJSON(filename,obj){
  const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function exportFiscal(){
  const docs=await getDocMetas(),year=Number($('fiscalYear').value),taxDocs=docs.filter(d=>d.includeTax&&Number(d.year)===year);
  exportJSON(`gridledger-dossier-fiscal-${year}.json`,{version:2,year,country:$('fiscalCountry').value,generatedAt:new Date().toISOString(),scenario:currentState.taxScenarios?.[String(year)]||null,documents:taxDocs});
}
async function exportBackup(){
  currentState.settings=currentState.settings||{};
  currentState.settings.lastBackupAt=nowIso();
  await saveState();
  const cfg=getConfig(),records=await dbGetAll();
  const packed=records.map(r=>({id:r.id,type:r.type,iv:r.iv,data:bytesToB64(r.data)}));
  exportJSON(`gridledger-backup-${new Date().toISOString().slice(0,10)}.gridledger`,{
    format:'GRIDLEDGER_ENCRYPTED_BACKUP',version:1,createdAt:new Date().toISOString(),config:cfg,records:packed
  });
}
async function importBackupFile(ev){
  const f=ev.target.files[0];if(!f)return;
  try{
    const obj=JSON.parse(await f.text());
    if(obj.format!=='GRIDLEDGER_ENCRYPTED_BACKUP'||obj.version!==1||!obj.config||!Array.isArray(obj.records))throw new Error('format');
    if(!confirm('Restaurer cette sauvegarde remplacera le coffre local actuel. Continuer ?')){ev.target.value='';return}
    await dbClear();
    for(const r of obj.records)await dbPut({id:r.id,type:r.type,iv:r.iv,data:b64ToBytes(r.data).buffer});
    setConfig(obj.config);
    alert('Sauvegarde restaurée. Déverrouille maintenant avec le mot de passe utilisé pour cette sauvegarde.');
    ev.target.value='';lockVault();
  }catch(e){alert('Sauvegarde invalide ou illisible.');ev.target.value=''}
}
async function importLegacyFile(ev){
  const f=ev.target.files[0];if(!f)return;
  try{
    const obj=JSON.parse(await f.text());
    if(!obj||!Array.isArray(obj.locations)||!Array.isArray(obj.bots)||!Array.isArray(obj.movements))throw new Error('format');
    if(!confirm('Remplacer les données comptables actuelles par cet ancien export ? Les documents chiffrés restent inchangés.')){ev.target.value='';return}
    currentState=ensureStateShape({...demoState(),...obj,settings:{autoLockMinutes:currentState.settings?.autoLockMinutes||5,...(obj.settings||{})}});
    await saveState();renderAll();alert('Anciennes données importées puis chiffrées.');
  }catch{alert('Ancien fichier JSON non reconnu.')}
  ev.target.value='';
}
async function resetAll(){
  if(!confirm('EFFACER le coffre local, les documents et la configuration de chiffrement ? Cette action est irréversible sans sauvegarde.'))return;
  await dbClear();localStorage.removeItem(CFG_KEY);vaultKey=null;currentState=null;
  location.reload();
}
async function changeAutoLock(){
  const mins=Number($('autoLockMinutes').value);
  currentState.settings=currentState.settings||{};currentState.settings.autoLockMinutes=mins;
  await saveState();$('dashAutoLock').textContent=mins+' min';resetInactivity();
}

async function init(){
  const supported=!!(window.crypto&&crypto.subtle&&window.indexedDB);
  $('unsupportedPane').hidden=supported;
  if(!supported){$('createVaultPane').hidden=true;$('unlockVaultPane').hidden=true;return}
  const cfg=getConfig();
  $('createVaultPane').hidden=!!cfg;
  $('unlockVaultPane').hidden=!cfg;
}
document.querySelectorAll('.bottomNav button').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.screen)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.go)));
$('createVaultBtn').addEventListener('click',createVault);
$('unlockVaultBtn').addEventListener('click',unlockVault);
$('unlockPassword').addEventListener('keydown',e=>{if(e.key==='Enter')unlockVault()});
$('lockNowBtn').addEventListener('click',lockVault);
$('saveDocBtn').addEventListener('click',saveDocument);
$('captureAnalyze').addEventListener('click',analyzeCapture);
$('toggleCaptureAdvanced').addEventListener('click',()=>{const on=document.body.classList.toggle('captureAdvanced');$('toggleCaptureAdvanced').textContent=on?'Masquer les outils avancés':'Afficher les outils avancés';});
$('captureOCR').addEventListener('click',runCaptureOCR);
$('shareCaptureAssistant').addEventListener('click',shareCaptureToAssistant);
$('saveCaptureBot').addEventListener('click',saveCaptureBotSnapshot);
$('rereadMissingBtn').addEventListener('click',rereadMissingFields);
$('zoomCaptureBtn').addEventListener('click',()=>{if(!currentCaptureData)return;$('captureZoomImage').src=currentCaptureData;$('captureZoomModal').hidden=false;});
$('closeZoomBtn').addEventListener('click',()=>{$('captureZoomModal').hidden=true;});
$('closePointerOCRBtn').addEventListener('click',closePointerOCR);
$('pointerOCRImage').addEventListener('click',pointerOCRAt);
$('usePointerManualValue').addEventListener('click',usePointerManualValue);
$('pointerManualValue').addEventListener('keydown',e=>{if(e.key==='Enter')usePointerManualValue();});
$('fiscalYear').addEventListener('change',renderFiscal);
$('exportFiscal').addEventListener('click',exportFiscal);
$('exportBackup').addEventListener('click',exportBackup);
$('importBackup').addEventListener('change',importBackupFile);
$('importLegacyState').addEventListener('change',importLegacyFile);
$('importBaseWorkbook').addEventListener('change',e=>importBaseWorkbook(e.target.files[0]));
$('resetAll').addEventListener('click',resetAll);
$('autoLockMinutes').addEventListener('change',changeAutoLock);

function handleCaptureFile(ev){
  const f=ev.target.files[0];
  if(!f)return;
  if(!f.type.startsWith('image/')){
    alert('Choisis une image ou une capture d’écran.');
    ev.target.value='';
    return;
  }
  currentCaptureFile=f;
  captureParsed=null;
  captureOCRConfidence=null;
  $('captureProposalPanel').hidden=true;
  $('captureResult').innerHTML='<span class="muted">Image chargée. Appuie sur « Lire l’image (OCR local) ».</span>';
  $('ocrStatus').className='ocrStatus';
  $('ocrStatus').textContent='Image prête pour l’OCR.';
  if($('shareCaptureAssistant'))$('shareCaptureAssistant').hidden=false;
  const r=new FileReader();
  r.onload=()=>{
    currentCaptureData=r.result;
    $('capturePreview').innerHTML=`<img src="${r.result}" alt="capture">`;
    $('zoomCaptureBtn').hidden=false;
  };
  r.readAsDataURL(f);
}
$('captureGalleryInput').addEventListener('change',handleCaptureFile);
$('captureCameraInput').addEventListener('change',handleCaptureFile);
$('backToBots').addEventListener('click',()=>{temporaryDemoSnapshot=null;nav('bots');});
$('botChartRange').addEventListener('change',()=>{if(selectedBotId)renderBotDetail();});
$('toggleDemoSnapshot').addEventListener('click',toggleTemporaryDemoSnapshot);
$('botMoveDirection').addEventListener('change',updateBotMoveRoleOptions);
$('saveBotMovement').addEventListener('click',saveBotMovement);
$('botFeeTreatment').addEventListener('change',updateBotFeeHelp);
$('saveBotFee').addEventListener('click',saveBotFee);
$('saveBotObservedValue').addEventListener('click',saveBotObservedValue);
$('openAddLocation').addEventListener('click',()=>{$('addLocationPanel').hidden=!$('addLocationPanel').hidden;});
$('saveNewLocation').addEventListener('click',saveNewLocation);
$('generalMoveType').addEventListener('change',updateGeneralMovementForm);
$('saveGeneralMovement').addEventListener('click',saveGeneralMovement);
$('historyFilter').addEventListener('change',renderHistory);
$('saveGoals').addEventListener('click',saveGoals);
$('refreshQuality').addEventListener('click',renderQuality);
$('assistantRefreshContext').addEventListener('click',renderAssistant);
$('assistantShareContext').addEventListener('click',shareAssistantContext);
$('assistantCopyContext').addEventListener('click',copyAssistantContext);
$('saveTaxScenario').addEventListener('click',saveTaxScenario);
$('fiscalCountry').addEventListener('change',async()=>{currentState.fiscal.country=$('fiscalCountry').value;await saveState();});
$('saveStrategyEpoch').addEventListener('click',saveStrategyEpoch);
$('closeBotLifecycle').addEventListener('click',closeBotLifecycle);
$('addBotBtn').addEventListener('click',async()=>{
  const name=prompt('Nom du bot fictif ?');if(!name)return;
  const lid='botloc-'+uid(),id='bot-'+uid();
  await mutateState(s=>{
    s.locations.push({id:lid,name,type:'BOT',class:'MOBILISABLE',baseline:0,balance:0});
    s.bots.push({id,name,platform:'',pair:'',locationId:lid,baseline:0,value:0,gridProfit:0,latent:0,status:'ACTIVE'});
  });
});

['pointerdown','keydown','touchstart'].forEach(evt=>document.addEventListener(evt,()=>{if(vaultKey)resetInactivity()},{passive:true}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&vaultKey)resetInactivity()});

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('installBtn').hidden=false});
$('installBtn').addEventListener('click',async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('installBtn').hidden=true});

if('serviceWorker' in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
init();
