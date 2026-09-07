(() => {
'use strict';

const GL_CLOUD_VERSION = '3.0-cloud-beta-1';
const SUPABASE_URL = 'https://kstuwdxehaqmlihewnjk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XdI7nTIoVdYg934ntAiFAw_kpmRPYO4';
const SESSION_RECORD_ID = 'gridledger-cloud-session-v1';
const TEMP_SESSION_KEY = 'gridledger-cloud-temp-session-v1';
const APP_ORIGIN = 'https://dejanovicbranko-bot.github.io/';

let cloudSession = null;
let cloudUser = null;
let cloudPortfolio = null;
let syncBusy = false;

const q = (sel, root=document) => root.querySelector(sel);
const qa = (sel, root=document) => [...root.querySelectorAll(sel)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeText(v){ return String(v ?? ''); }
function nowIsoCloud(){ return new Date().toISOString(); }

function normalizeConfidence(v){
  return ['CERTAIN','ESTIMATED','TO_VERIFY'].includes(v) ? v : 'ESTIMATED';
}
function normalizeSourceType(v){
  const x = String(v || '').toUpperCase();
  if (['MANUAL','SCREENSHOT','PHOTO','CSV','SYSTEM'].includes(x)) return x;
  if (x === 'CHATGPT_CONFIRMED') return x;
  return 'IMPORT';
}
function uuidish(v){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v||''));
}
function nativeVal(obj, keys){
  for(const k of keys){
    if(obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return Number(obj[k]);
  }
  return null;
}
function currentAppUnlocked(){
  try { return !!currentState && !!vaultKey; } catch { return false; }
}
async function waitForAppUnlocked(timeoutMs=120000){
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    if(currentAppUnlocked()) return true;
    await sleep(250);
  }
  return false;
}

function parseSessionFromHash(){
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if(!hash) return null;
  const p = new URLSearchParams(hash);
  const access_token = p.get('access_token');
  const refresh_token = p.get('refresh_token');
  if(!access_token || !refresh_token) return null;
  const expires_in = Number(p.get('expires_in') || 3600);
  const session = {
    access_token,
    refresh_token,
    token_type:p.get('token_type') || 'bearer',
    expires_in,
    expires_at: Math.floor(Date.now()/1000) + expires_in - 30
  };
  sessionStorage.setItem(TEMP_SESSION_KEY, JSON.stringify(session));
  history.replaceState(null, '', location.pathname + location.search);
  return session;
}

async function persistSession(session){
  if(!session || !currentAppUnlocked()) return false;
  const enc = await encryptJSON(session);
  await dbPut({
    id: SESSION_RECORD_ID,
    type:'cloud-session',
    iv: enc.iv,
    data: enc.data,
    updatedAt: nowIsoCloud()
  });
  cloudSession = session;
  sessionStorage.removeItem(TEMP_SESSION_KEY);
  return true;
}
async function loadPersistedSession(){
  if(!currentAppUnlocked()) return null;
  const rec = await dbGet(SESSION_RECORD_ID);
  if(!rec) return null;
  try{
    const s = await decryptJSON(rec);
    cloudSession = s;
    return s;
  }catch{
    return null;
  }
}
async function clearPersistedSession(){
  try { await dbDelete(SESSION_RECORD_ID); } catch {}
  sessionStorage.removeItem(TEMP_SESSION_KEY);
  cloudSession=null; cloudUser=null; cloudPortfolio=null;
}

async function authFetch(path, options={}){
  const headers = {
    'apikey': SUPABASE_KEY,
    'Content-Type':'application/json',
    ...(options.headers || {})
  };
  return fetch(SUPABASE_URL + path, {...options, headers});
}

async function refreshSessionIfNeeded(){
  if(!cloudSession) return null;
  const now = Math.floor(Date.now()/1000);
  if(cloudSession.expires_at && cloudSession.expires_at > now + 60) return cloudSession;
  const r = await authFetch('/auth/v1/token?grant_type=refresh_token',{
    method:'POST',
    body:JSON.stringify({refresh_token:cloudSession.refresh_token})
  });
  if(!r.ok){
    await clearPersistedSession();
    throw new Error('Session cloud expirée. Reconnecte GridLedger.');
  }
  const d = await r.json();
  cloudSession = {
    access_token:d.access_token,
    refresh_token:d.refresh_token,
    token_type:d.token_type || 'bearer',
    expires_in:Number(d.expires_in || 3600),
    expires_at:Math.floor(Date.now()/1000)+Number(d.expires_in || 3600)-30
  };
  await persistSession(cloudSession);
  return cloudSession;
}
async function authHeaders(extra={}){
  await refreshSessionIfNeeded();
  if(!cloudSession?.access_token) throw new Error('GridLedger Cloud n’est pas connecté.');
  return {
    'apikey':SUPABASE_KEY,
    'Authorization':'Bearer '+cloudSession.access_token,
    'Content-Type':'application/json',
    ...extra
  };
}
async function getCloudUser(){
  const r = await fetch(SUPABASE_URL+'/auth/v1/user',{headers:await authHeaders()});
  if(!r.ok) throw new Error('Impossible de vérifier la session cloud.');
  cloudUser = await r.json();
  return cloudUser;
}
async function rpc(name,args={}){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:await authHeaders({'Prefer':'return=representation'}),
    body:JSON.stringify(args)
  });
  const txt = await r.text();
  let data=null;
  try{ data = txt ? JSON.parse(txt) : null; }catch{ data={message:txt}; }
  if(!r.ok) throw new Error(data?.message || data?.error || `RPC ${name} impossible`);
  return data;
}
async function tableGet(table, params={}){
  const usp = new URLSearchParams(params);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${usp.toString()}`,{
    headers:await authHeaders()
  });
  const d = await r.json();
  if(!r.ok) throw new Error(d?.message || `Lecture ${table} impossible`);
  return d;
}
async function tablePost(table, body, {onConflict=null, ignoreDuplicates=false}={}){
  const usp = new URLSearchParams();
  if(onConflict) usp.set('on_conflict',onConflict);
  const prefer = ignoreDuplicates
    ? 'resolution=ignore-duplicates,return=representation'
    : (onConflict ? 'resolution=merge-duplicates,return=representation' : 'return=representation');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${usp.toString()?'?'+usp.toString():''}`,{
    method:'POST',
    headers:await authHeaders({'Prefer':prefer}),
    body:JSON.stringify(body)
  });
  const txt=await r.text();
  let d=null;
  try{d=txt?JSON.parse(txt):null}catch{d={message:txt}}
  if(!r.ok) throw new Error(d?.message || `Écriture ${table} impossible`);
  return d;
}
async function tablePatch(table, id, body){
  const usp = new URLSearchParams({id:'eq.'+id});
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${usp.toString()}`,{
    method:'PATCH',
    headers:await authHeaders({'Prefer':'return=representation'}),
    body:JSON.stringify(body)
  });
  const d=await r.json();
  if(!r.ok) throw new Error(d?.message || `Mise à jour ${table} impossible`);
  return d;
}

async function ensurePortfolio(){
  let p = await rpc('gridledger_create_portfolio_if_missing',{});
  if(Array.isArray(p)) p=p[0];
  cloudPortfolio = p;
  return p;
}

async function findByExternalKey(table, portfolioId, externalKey){
  const rows = await tableGet(table,{
    select:'*',
    portfolio_id:'eq.'+portfolioId,
    external_key:'eq.'+externalKey,
    limit:'1'
  });
  return rows?.[0] || null;
}

function localLatestObservation(locationId){
  try{
    const obs=(currentState.observations||[]).filter(o=>o.locationId===locationId)
      .sort((a,b)=>String(a.observedAt||a.date||'').localeCompare(String(b.observedAt||b.date||'')));
    return obs.length ? (obs[obs.length-1].observedAt || obs[obs.length-1].date) : null;
  }catch{return null}
}

async function uploadLocalState(){
  if(!currentAppUnlocked()) throw new Error('Déverrouille d’abord le coffre local.');
  const user = cloudUser || await getCloudUser();
  const p = cloudPortfolio || await ensurePortfolio();
  const pid = p.id;
  const uid = user.id;

  await tablePatch('gridledger_portfolios', pid, {
    name:'GridLedger',
    reporting_currency:currentState.reportingCurrency || 'EUR',
    goals:currentState.goals || {},
    planning:currentState.planning || {},
    tax_scenarios:currentState.taxScenarios || {},
    fiscal:currentState.fiscal || {}
  });

  const locMap = new Map();
  for(const l of currentState.locations || []){
    const ext = String(l.id);
    const existing = await findByExternalKey('gridledger_locations',pid,ext);
    const common = {
      portfolio_id:pid,user_id:uid,external_key:ext,
      name:l.name || 'Actif',
      kind:['ACCOUNT','ASSET','BOT','OTHER'].includes(l.type)?l.type:'OTHER',
      liquidity_class:l.class==='ILLIQUID'?'ILLIQUID_FINANCIAL':(l.class || 'MOBILISABLE'),
      opening_value_eur:Number(l.baseline||0),
      confidence:normalizeConfidence(l.confidence),
      note:l.note || null
    };
    let row;
    if(existing){
      const r=await tablePatch('gridledger_locations',existing.id,common);
      row=r?.[0]||existing;
    }else{
      const r=await tablePost('gridledger_locations',{
        ...common,
        current_value_eur:Number(l.balance||0),
        last_observed_at:l.lastObservedAt || localLatestObservation(l.id) || null
      });
      row=r?.[0];
    }
    if(row) locMap.set(l.id,row.id);
  }

  const botMap = new Map();
  for(const b of currentState.bots || []){
    const ext=String(b.id);
    const locationId=locMap.get(b.locationId);
    if(!locationId) continue;
    const existing=await findByExternalKey('gridledger_bots',pid,ext);
    const common={
      portfolio_id:pid,user_id:uid,location_id:locationId,external_key:ext,
      name:b.name || 'Bot',
      platform:b.platform || null,
      pair:b.pair || null,
      status:['ACTIVE','PAUSED','CLOSED'].includes(b.status)?b.status:'ACTIVE',
      opening_value_eur:Number(b.baseline||0),
      closed_at:b.closedAt || null
    };
    let row;
    if(existing){
      const r=await tablePatch('gridledger_bots',existing.id,common);
      row=r?.[0]||existing;
    }else{
      const r=await tablePost('gridledger_bots',{
        ...common,
        current_value_eur:Number(b.value||0),
        value_observed_at:b.valueObservedAt || null
      });
      row=r?.[0];
    }
    if(row) botMap.set(b.id,row.id);
  }

  for(const m of currentState.movements || []){
    const obj={
      portfolio_id:pid,user_id:uid,external_key:String(m.id),
      movement_type:m.type,
      event_date:m.date || new Date().toISOString().slice(0,10),
      from_location_id:locMap.get(m.from) || null,
      to_location_id:locMap.get(m.to) || null,
      location_id:locMap.get(m.locationId) || null,
      bot_id:botMap.get(m.botId) || null,
      value_eur:Number(m.value||0),
      bot_role:m.botRole || null,
      fee_treatment:m.feeTreatment || null,
      source_type:normalizeSourceType(m.sourceType),
      confidence:normalizeConfidence(m.confidence),
      note:m.note || null,
      source_meta:{local_id:m.id,local_source_type:m.sourceType||null,reversal_of_local:m.reversalOf||null}
    };
    if(!obj.value_eur) continue;
    await tablePost('gridledger_movements',obj,{onConflict:'portfolio_id,external_key',ignoreDuplicates:true});
  }

  for(const s of currentState.snapshots || []){
    const botId=botMap.get(s.botId);
    if(!botId) continue;
    const obj={
      portfolio_id:pid,user_id:uid,external_key:String(s.id),
      bot_id:botId,
      event_date:s.date || new Date().toISOString().slice(0,10),
      captured_at:s.capturedAt || s.createdAt || new Date().toISOString(),
      native_unit:String(s.nativeUnit || s.unit || 'USDT').toUpperCase(),
      grid_profit_native:nativeVal(s,['gridProfitNative','gridProfit','grid']),
      latent_pnl_native:nativeVal(s,['latentNative','latent']),
      withdrawn_native:nativeVal(s,['withdrawnNative','withdrawn']),
      investment_native:nativeVal(s,['investmentNative','investment']),
      current_profit_native:nativeVal(s,['currentProfitNative','currentProfit']),
      current_value_eur:nativeVal(s,['currentValueEUR','currentValueEur','valueEUR']),
      source_type:normalizeSourceType(s.sourceType),
      confidence:normalizeConfidence(s.confidence),
      source_fingerprint:s.fingerprint || s.sourceFingerprint || null,
      source_meta:{local_id:s.id,local_source_type:s.sourceType||null}
    };
    await tablePost('gridledger_snapshots',obj,{onConflict:'portfolio_id,external_key',ignoreDuplicates:true});
  }

  for(const o of currentState.observations || []){
    const locationId=locMap.get(o.locationId);
    if(!locationId) continue;
    const botLocal=(currentState.bots||[]).find(b=>b.locationId===o.locationId)?.id;
    const obj={
      portfolio_id:pid,user_id:uid,external_key:String(o.id),
      location_id:locationId,
      bot_id:botMap.get(o.botId || botLocal) || null,
      event_date:o.date || new Date().toISOString().slice(0,10),
      observed_at:o.observedAt || (o.date ? o.date+'T12:00:00Z' : new Date().toISOString()),
      value_eur:Number(o.value||0),
      source_type:normalizeSourceType(o.sourceType),
      confidence:normalizeConfidence(o.confidence),
      source_fingerprint:o.fingerprint || o.sourceFingerprint || null,
      source_meta:{local_id:o.id,local_source_type:o.sourceType||null}
    };
    await tablePost('gridledger_observations',obj,{onConflict:'portfolio_id,external_key',ignoreDuplicates:true});
  }
}

function cloudToLocalClass(v){
  return v==='ILLIQUID_FINANCIAL' ? 'ILLIQUID' : v;
}
function cloudToLocalSource(v){
  return v || 'IMPORT';
}

async function downloadCloudState(){
  if(!currentAppUnlocked()) throw new Error('Déverrouille d’abord le coffre local.');
  const p=cloudPortfolio || await ensurePortfolio();
  const pid=p.id;

  const [portfolioRows, locations, bots, movements, snapshots, observations, proposals] = await Promise.all([
    tableGet('gridledger_portfolios',{select:'*',id:'eq.'+pid,limit:'1'}),
    tableGet('gridledger_locations',{select:'*',portfolio_id:'eq.'+pid}),
    tableGet('gridledger_bots',{select:'*',portfolio_id:'eq.'+pid}),
    tableGet('gridledger_movements',{select:'*',portfolio_id:'eq.'+pid,order:'event_date.asc,created_at.asc'}),
    tableGet('gridledger_snapshots',{select:'*',portfolio_id:'eq.'+pid,order:'event_date.asc,captured_at.asc'}),
    tableGet('gridledger_observations',{select:'*',portfolio_id:'eq.'+pid,order:'event_date.asc,observed_at.asc'}),
    tableGet('gridledger_proposals',{select:'*',portfolio_id:'eq.'+pid,status:'eq.PENDING',order:'created_at.desc'})
  ]);

  const pp=portfolioRows?.[0];
  if(pp){
    if(pp.goals && Object.keys(pp.goals).length) currentState.goals=pp.goals;
    if(pp.planning && Object.keys(pp.planning).length) currentState.planning=pp.planning;
    if(pp.tax_scenarios && Object.keys(pp.tax_scenarios).length) currentState.taxScenarios=pp.tax_scenarios;
    if(pp.fiscal && Object.keys(pp.fiscal).length) currentState.fiscal=pp.fiscal;
  }

  const locUuidToLocal=new Map();
  for(const l of locations){
    const localId=l.external_key || ('cloud-loc-'+l.id);
    locUuidToLocal.set(l.id,localId);
    let loc=(currentState.locations||[]).find(x=>x.id===localId);
    if(!loc){
      loc={id:localId,name:l.name,type:l.kind,class:cloudToLocalClass(l.liquidity_class),baseline:Number(l.opening_value_eur||0),balance:Number(l.current_value_eur||0)};
      currentState.locations.push(loc);
    }
    loc.name=l.name;
    loc.type=l.kind;
    loc.class=cloudToLocalClass(l.liquidity_class);
    loc.baseline=Number(l.opening_value_eur||0);
    loc.balance=Number(l.current_value_eur||0);
    loc.lastObservedAt=l.last_observed_at || loc.lastObservedAt || null;
    loc.confidence=l.confidence || loc.confidence || 'ESTIMATED';
  }

  const botUuidToLocal=new Map();
  for(const b of bots){
    const localId=b.external_key || ('cloud-bot-'+b.id);
    botUuidToLocal.set(b.id,localId);
    let bot=(currentState.bots||[]).find(x=>x.id===localId);
    if(!bot){
      bot={id:localId,name:b.name,locationId:locUuidToLocal.get(b.location_id),platform:b.platform||'',pair:b.pair||'',status:b.status||'ACTIVE',baseline:Number(b.opening_value_eur||0),value:Number(b.current_value_eur||0)};
      currentState.bots.push(bot);
    }
    bot.name=b.name;
    bot.locationId=locUuidToLocal.get(b.location_id) || bot.locationId;
    bot.platform=b.platform || '';
    bot.pair=b.pair || '';
    bot.status=b.status || 'ACTIVE';
    bot.baseline=Number(b.opening_value_eur||0);
    bot.value=Number(b.current_value_eur||0);
    bot.valueObservedAt=b.value_observed_at || bot.valueObservedAt || null;
    bot.closedAt=b.closed_at || bot.closedAt || null;
  }

  const movementIds=new Set((currentState.movements||[]).map(x=>x.id));
  for(const m of movements){
    const localId=m.external_key || ('cloud-mv-'+m.id);
    if(movementIds.has(localId)) continue;
    currentState.movements.push({
      id:localId,
      type:m.movement_type,
      date:m.event_date,
      createdAt:m.created_at,
      from:locUuidToLocal.get(m.from_location_id) || undefined,
      to:locUuidToLocal.get(m.to_location_id) || undefined,
      locationId:locUuidToLocal.get(m.location_id) || undefined,
      botId:botUuidToLocal.get(m.bot_id) || undefined,
      value:Number(m.value_eur||0),
      botRole:m.bot_role || undefined,
      feeTreatment:m.fee_treatment || undefined,
      sourceType:cloudToLocalSource(m.source_type),
      confidence:m.confidence || 'ESTIMATED',
      note:m.note || '',
      cloudId:m.id
    });
    movementIds.add(localId);
  }

  const snapshotIds=new Set((currentState.snapshots||[]).map(x=>x.id));
  for(const s of snapshots){
    const localId=s.external_key || ('cloud-sn-'+s.id);
    if(snapshotIds.has(localId)) continue;
    const botLocal=botUuidToLocal.get(s.bot_id);
    if(!botLocal) continue;
    currentState.snapshots.push({
      id:localId,botId:botLocal,date:s.event_date,capturedAt:s.captured_at,
      nativeUnit:s.native_unit,
      gridProfitNative:s.grid_profit_native===null?null:Number(s.grid_profit_native),
      latentNative:s.latent_pnl_native===null?null:Number(s.latent_pnl_native),
      withdrawnNative:s.withdrawn_native===null?null:Number(s.withdrawn_native),
      investmentNative:s.investment_native===null?null:Number(s.investment_native),
      currentProfitNative:s.current_profit_native===null?null:Number(s.current_profit_native),
      currentValueEUR:s.current_value_eur===null?null:Number(s.current_value_eur),
      sourceType:cloudToLocalSource(s.source_type),confidence:s.confidence || 'ESTIMATED',
      cloudId:s.id
    });
    snapshotIds.add(localId);
  }

  const observationIds=new Set((currentState.observations||[]).map(x=>x.id));
  for(const o of observations){
    const localId=o.external_key || ('cloud-ob-'+o.id);
    if(observationIds.has(localId)) continue;
    const locLocal=locUuidToLocal.get(o.location_id);
    if(!locLocal) continue;
    currentState.observations.push({
      id:localId,locationId:locLocal,
      botId:botUuidToLocal.get(o.bot_id) || undefined,
      value:Number(o.value_eur||0),date:o.event_date,observedAt:o.observed_at,
      confidence:o.confidence || 'ESTIMATED',sourceType:cloudToLocalSource(o.source_type),
      cloudId:o.id
    });
    observationIds.add(localId);
  }

  currentState.settings=currentState.settings||{};
  currentState.settings.cloudSync={
    ...(currentState.settings.cloudSync||{}),
    enabled:true,
    lastSyncAt:nowIsoCloud(),
    backend:'SUPABASE',
    rawDocumentsSynced:false,
    rawScreenshotsSynced:false
  };
  await saveState();
  cloudPortfolio=pp || cloudPortfolio;
  renderPendingProposals(proposals || []);
  refreshAppScreens();
}

async function syncNow(){
  if(syncBusy) return;
  if(!q('#glCloudConsent')?.checked && !currentState?.settings?.cloudSyncConsentAt){
    setCloudStatus('Coche d’abord l’accord de synchronisation structurée.', 'warn');
    return;
  }
  syncBusy=true;
  setCloudStatus('Synchronisation en cours…','info');
  try{
    await getCloudUser();
    await ensurePortfolio();

    currentState.settings=currentState.settings||{};
    if(!currentState.settings.cloudSyncConsentAt){
      currentState.settings.cloudSyncConsentAt=nowIsoCloud();
      await saveState();
    }

    await uploadLocalState();
    await downloadCloudState();
    setCloudStatus('Synchronisé. ChatGPT et GridLedger partagent maintenant les données comptables structurées.','ok');
  }catch(e){
    console.error(e);
    setCloudStatus(e?.message || 'Synchronisation impossible.','bad');
  }finally{
    syncBusy=false;
  }
}

async function pullNow(){
  if(syncBusy) return;
  syncBusy=true;
  setCloudStatus('Récupération des mises à jour ChatGPT…','info');
  try{
    await getCloudUser();
    await ensurePortfolio();
    await downloadCloudState();
    setCloudStatus('Mises à jour récupérées.','ok');
  }catch(e){
    console.error(e);
    setCloudStatus(e?.message || 'Récupération impossible.','bad');
  }finally{
    syncBusy=false;
  }
}

function refreshAppScreens(){
  const names=['renderDashboard','renderPatrimoine','renderBots','renderHistory','renderGoals','renderAssistant'];
  for(const n of names){
    try{
      const fn = globalThis[n] || eval(`typeof ${n}==='function' ? ${n} : null`);
      if(typeof fn==='function') fn();
    }catch{}
  }
}

async function sendMagicLink(){
  const email=(q('#glCloudEmail')?.value || '').trim();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){
    setCloudStatus('Saisis une adresse e-mail valide.','warn'); return;
  }
  setCloudStatus('Envoi du lien sécurisé…','info');
  const redirect=APP_ORIGIN;
  const r=await authFetch('/auth/v1/otp?redirect_to='+encodeURIComponent(redirect),{
    method:'POST',
    body:JSON.stringify({email,create_user:true})
  });
  const txt=await r.text();
  let d={}; try{d=txt?JSON.parse(txt):{}}catch{}
  if(!r.ok){
    setCloudStatus(d?.msg || d?.message || 'Connexion impossible. Vérifie la configuration Auth Supabase.','bad');
    return;
  }
  setCloudStatus('Lien envoyé. Ouvre l’e-mail sur ton téléphone et touche le lien de connexion.','ok');
}

async function disconnectCloud(){
  await clearPersistedSession();
  updateCloudUi();
  setCloudStatus('Cloud déconnecté de cet appareil. Les données déjà synchronisées restent dans Supabase.','info');
}

async function confirmProposal(id){
  try{
    setCloudStatus('Confirmation en cours…','info');
    await rpc('gridledger_confirm_proposal',{p_proposal_id:id,p_decision_note:'Confirmé dans GridLedger'});
    await downloadCloudState();
    setCloudStatus('Proposition confirmée et enregistrée.','ok');
  }catch(e){ setCloudStatus(e?.message || 'Confirmation impossible.','bad'); }
}
async function rejectProposal(id){
  try{
    await rpc('gridledger_reject_proposal',{p_proposal_id:id,p_decision_note:'Refusé dans GridLedger'});
    await downloadCloudState();
    setCloudStatus('Proposition refusée.','info');
  }catch(e){ setCloudStatus(e?.message || 'Refus impossible.','bad'); }
}

function escapeCloud(v){
  return safeText(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function proposalSummary(p){
  const x=p.payload||{};
  if(p.proposal_kind==='SNAPSHOT') return `Snapshot · ${escapeCloud(x.event_date||'date à vérifier')} · ${escapeCloud(x.native_unit||'unité ?')}`;
  if(p.proposal_kind==='FEE') return `Frais · ${escapeCloud(x.value_eur||'?')} € · ${escapeCloud(x.fee_treatment||'UNKNOWN')}`;
  if(p.proposal_kind==='MOVEMENT') return `${escapeCloud(x.movement_type||'Mouvement')} · ${escapeCloud(x.value_eur||'?')} €`;
  if(p.proposal_kind==='OBSERVATION') return `Observation · ${escapeCloud(x.value_eur||'?')} €`;
  return escapeCloud(p.proposal_kind);
}
function renderPendingProposals(proposals){
  const host=q('#glCloudProposals');
  if(!host) return;
  if(!proposals?.length){
    host.innerHTML='<div class="glCloudMuted">Aucune proposition ChatGPT en attente.</div>';
    return;
  }
  host.innerHTML=proposals.map(p=>`
    <div class="glCloudProposal">
      <b>${escapeCloud(p.proposal_kind)}</b>
      <div>${proposalSummary(p)}</div>
      <small>${escapeCloud(p.created_at?.slice(0,16).replace('T',' ')||'')}</small>
      <div class="glCloudActions">
        <button data-gl-confirm="${p.id}">Confirmer</button>
        <button class="glSecondary" data-gl-reject="${p.id}">Refuser</button>
      </div>
    </div>`).join('');
  qa('[data-gl-confirm]',host).forEach(b=>b.addEventListener('click',()=>confirmProposal(b.dataset.glConfirm)));
  qa('[data-gl-reject]',host).forEach(b=>b.addEventListener('click',()=>rejectProposal(b.dataset.glReject)));
}

function setCloudStatus(text,kind='info'){
  const el=q('#glCloudStatus');
  if(!el) return;
  el.textContent=text;
  el.dataset.kind=kind;
}
function updateDashboardCloudBadge(){
  const el=q('#dashboardAssistantStatus');
  if(!el) return;
  if(cloudSession){
    el.textContent='Cloud v3 connecté · ChatGPT peut préparer des mises à jour, validation humaine obligatoire.';
  }else{
    el.textContent='Pont local prêt · Cloud v3 non connecté.';
  }
}
function updateCloudUi(){
  const connected=!!cloudSession;
  const authBox=q('#glCloudAuthBox');
  const connectedBox=q('#glCloudConnectedBox');
  if(authBox) authBox.hidden=connected;
  if(connectedBox) connectedBox.hidden=!connected;
  if(q('#glCloudIdentity')) q('#glCloudIdentity').textContent=cloudUser?.email || (connected?'Session chiffrée sur cet appareil':'');
  updateDashboardCloudBadge();
}

function injectStyles(){
  if(q('#glCloudStyle')) return;
  const s=document.createElement('style');
  s.id='glCloudStyle';
  s.textContent=`
  #glCloudPanel{margin-top:18px;padding:18px;border:1px solid #d8e0e8;border-radius:18px;background:#fff;color:#24384a}
  #glCloudPanel h2{margin:0 0 8px;font-size:1.25rem}
  #glCloudPanel input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cbd6df;border-radius:10px;margin:6px 0 10px}
  #glCloudPanel button{border:0;border-radius:10px;padding:11px 14px;font-weight:700;background:#245f89;color:white;margin:4px 6px 4px 0}
  #glCloudPanel button.glSecondary{background:#e9eef3;color:#294257}
  .glCloudNote{font-size:.88rem;line-height:1.4;color:#617383;margin:8px 0}
  .glCloudConsent{display:flex;gap:9px;align-items:flex-start;font-size:.9rem;margin:10px 0}
  .glCloudConsent input{width:auto;margin-top:3px}
  #glCloudStatus{padding:10px 12px;border-radius:10px;background:#edf3f7;margin:10px 0;font-size:.9rem}
  #glCloudStatus[data-kind="ok"]{background:#e9f5ec}
  #glCloudStatus[data-kind="warn"]{background:#fff4d8}
  #glCloudStatus[data-kind="bad"]{background:#fdeaea}
  .glCloudProposal{border-top:1px solid #e5eaee;padding:12px 0}
  .glCloudProposal small,.glCloudMuted{color:#71808d}
  .glCloudActions{margin-top:7px}
  `;
  document.head.appendChild(s);
}

function mountUi(){
  if(q('#glCloudPanel')) return;
  injectStyles();
  const host=q('#assistant') || q('#dashboard .assistantPanel') || q('#dashboard');
  if(!host) return;
  const panel=document.createElement('div');
  panel.id='glCloudPanel';
  panel.innerHTML=`
    <h2>GridLedger Cloud v3</h2>
    <div class="glCloudNote">
      Ce pont synchronise uniquement les données comptables structurées nécessaires à GridLedger.
      Les captures brutes, documents et mot de passe du coffre restent sur le téléphone.
    </div>

    <div id="glCloudAuthBox">
      <label>E-mail de connexion GridLedger Cloud</label>
      <input id="glCloudEmail" type="email" autocomplete="email" placeholder="ton e-mail">
      <button id="glCloudSendLink">Envoyer le lien sécurisé</button>
    </div>

    <div id="glCloudConnectedBox" hidden>
      <div><b>Connecté :</b> <span id="glCloudIdentity"></span></div>
      <label class="glCloudConsent">
        <input id="glCloudConsent" type="checkbox">
        <span>J’accepte que les données comptables structurées soient copiées dans Supabase pour permettre la synchronisation avec ChatGPT. Aucune capture brute ni document n’est envoyé par ce bouton.</span>
      </label>
      <button id="glCloudSync">Synchroniser</button>
      <button id="glCloudPull" class="glSecondary">Récupérer les mises à jour ChatGPT</button>
      <button id="glCloudDisconnect" class="glSecondary">Déconnecter le cloud</button>
    </div>

    <div id="glCloudStatus">Cloud v3 prêt à être connecté.</div>
    <h3>Propositions ChatGPT</h3>
    <div id="glCloudProposals"><div class="glCloudMuted">Connexion nécessaire.</div></div>
  `;
  host.appendChild(panel);

  q('#glCloudSendLink')?.addEventListener('click',sendMagicLink);
  q('#glCloudSync')?.addEventListener('click',syncNow);
  q('#glCloudPull')?.addEventListener('click',pullNow);
  q('#glCloudDisconnect')?.addEventListener('click',disconnectCloud);

  if(currentState?.settings?.cloudSyncConsentAt && q('#glCloudConsent')) q('#glCloudConsent').checked=true;
  updateCloudUi();
}

async function bootstrapCloud(){
  parseSessionFromHash();
  await waitForAppUnlocked();

  const temp=sessionStorage.getItem(TEMP_SESSION_KEY);
  if(temp){
    try{
      cloudSession=JSON.parse(temp);
      await persistSession(cloudSession);
      setTimeout(()=>setCloudStatus('Connexion Supabase reçue. Tu peux maintenant synchroniser.','ok'),0);
    }catch{}
  }else{
    await loadPersistedSession();
  }

  mountUi();
  if(cloudSession){
    try{
      await getCloudUser();
      await ensurePortfolio();
      updateCloudUi();
      await downloadCloudState();
      setCloudStatus('Cloud connecté. Les données sont prêtes pour ChatGPT.','ok');
    }catch(e){
      console.error(e);
      setCloudStatus(e?.message || 'Session cloud à reconnecter.','warn');
    }
  }else{
    updateCloudUi();
  }

  // If the assistant screen is created/rendered later, retry mounting.
  for(let i=0;i<20;i++){
    await sleep(500);
    if(!q('#glCloudPanel')) mountUi();
  }
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',()=>bootstrapCloud().catch(console.error),{once:true});
}else{
  bootstrapCloud().catch(console.error);
}

})();