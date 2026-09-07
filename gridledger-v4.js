(() => {
'use strict';

/*
 GridLedger v4 cockpit
 UI-only evolution over the existing encrypted local ledger + Cloud bridge.
 No personal amounts are embedded in this public file.
*/
const GL4='4.0';
const euro=v=>Number(v||0).toLocaleString('fr-BE',{style:'currency',currency:'EUR'});
const num=(v,d=2)=>Number(v||0).toLocaleString('fr-BE',{minimumFractionDigits:d,maximumFractionDigits:d});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state=()=>{try{return typeof currentState!=='undefined'?currentState:null}catch{return null}};
const dateOf=x=>x?.capturedAt||x?.observedAt||x?.createdAt||(x?.date?x.date+'T12:00:00':'')||'';
const byDate=(a,b)=>String(dateOf(a)).localeCompare(String(dateOf(b)));
const latest=(arr)=>arr?.length?arr.slice().sort(byDate).at(-1):null;
const botSnaps=(s,id)=>(s.snapshots||[]).filter(x=>x.botId===id);
const activeBots=s=>(s.bots||[]).filter(b=>(b.status||'ACTIVE')!=='CLOSED' && Number(b.value||0)>0);
const closedBots=s=>(s.bots||[]).filter(b=>b.status==='CLOSED');

function realizedObs(s,bid){
  const r=(s.observations||[]).filter(o=>o.botId===bid && /^realized-(gain|loss)-eur-/.test(String(o.id||'')));
  const o=latest(r); if(!o)return null;
  const loss=String(o.id||'').startsWith('realized-loss-');
  return {eur:(loss?-1:1)*Number(o.value||0),date:o.date||'',confidence:o.confidence||'ESTIMATED'};
}
function realizedSummary(s){
  let gain=0,loss=0;
  for(const b of closedBots(s)){
    const r=realizedObs(s,b.id); if(!r)continue;
    if(r.eur>=0)gain+=r.eur; else loss+=r.eur;
  }
  return {gain,loss,net:gain+loss};
}
function locationTotals(s){
  const activeIds=new Set(activeBots(s).map(b=>b.locationId));
  const bot=activeBots(s).reduce((a,b)=>a+Number(b.value||0),0);
  const protectedValue=(s.locations||[]).filter(l=>l.class==='PROTECTED').reduce((a,l)=>a+Number(l.balance||0),0);
  const other=(s.locations||[]).filter(l=>!activeIds.has(l.id)&&l.class!=='PROTECTED'&&Number(l.balance||0)>0).reduce((a,l)=>a+Number(l.balance||0),0);
  return {bot,protectedValue,other,total:bot+protectedValue+other};
}
function latestNative(s,b){
  const sn=latest(botSnaps(s,b.id));
  return sn?{
    unit:sn.nativeUnit||sn.unit||'',
    grid:sn.gridProfitNative??sn.gridProfit??sn.grid,
    latent:sn.latentNative??sn.latent,
    current:sn.currentProfitNative??sn.currentProfit,
    date:sn.date||''
  }:null;
}
function confidenceBadge(c){
  const x=c==='CERTAIN'?['Certain','ok']:c==='TO_VERIFY'?['À vérifier','bad']:['Estimé','warn'];
  return `<span class="gl4Badge ${x[1]}">${x[0]}</span>`;
}
function tax(s){
  const r=realizedSummary(s), base=Math.max(0,r.net);
  return {base,t10:base*.10,t30:base*.30};
}
function contributionInfo(s){
  const val=(s.movements||[]).filter(m=>m.type==='CONTRIBUTION').reduce((a,m)=>a+Number(m.value||0),0);
  return {value:val,complete:false};
}
function quality(s){
  const issues=[];
  const c=contributionInfo(s);
  if(!c.complete)issues.push(['Apports historiques','Historique incomplet : le chiffre des apports tracés ne doit pas être utilisé comme total investi.','warn']);
  for(const b of closedBots(s)){if(!realizedObs(s,b.id))issues.push([b.name,'Résultat réalisé EUR encore à vérifier ou absent.','warn']);}
  const stale=activeBots(s).filter(b=>{
    const d=b.valueObservedAt||latest(botSnaps(s,b.id))?.date;
    if(!d)return true;
    return (Date.now()-new Date(String(d).length===10?d+'T12:00:00':d).getTime())>8*86400000;
  });
  if(stale.length)issues.push(['Valeurs actives',`${stale.length} bot(s) actif(s) ont une valeur de plus de 7 jours.`,'warn']);
  if(!issues.length)issues.push(['Comptabilité','Aucune anomalie détectée sur les contrôles v4.','ok']);
  return issues;
}
function monthKey(d){return String(d||'').slice(0,7)}
function realizedMonthly(s){
  const map=new Map();
  for(const b of closedBots(s)){
    const r=realizedObs(s,b.id); if(!r?.date)continue;
    const k=monthKey(r.date);map.set(k,(map.get(k)||0)+r.eur);
  }
  return [...map].sort((a,b)=>a[0].localeCompare(b[0]));
}
function renderBars(data){
  if(!data.length)return '<div class="gl4Empty">Pas encore assez d’historique réalisé.</div>';
  const max=Math.max(...data.map(x=>Math.abs(x[1])),1);
  return `<div class="gl4Bars">${data.map(([k,v])=>`<div class="gl4BarRow"><span>${esc(k)}</span><div class="gl4BarTrack"><i class="${v>=0?'pos':'neg'}" style="width:${Math.max(3,Math.abs(v)/max*100)}%"></i></div><b class="${v>=0?'posTxt':'negTxt'}">${v>=0?'+':''}${euro(v)}</b></div>`).join('')}</div>`;
}
function renderActiveCard(s,b){
  const n=latestNative(s,b);
  return `<article class="gl4Bot">
    <div class="gl4BotTop"><div><div class="gl4Platform">${esc(b.platform||'Plateforme')}</div><h3>${esc(b.name||'Bot')}</h3><div class="gl4Pair">${esc(b.pair||'')}</div></div><div class="gl4BotValue">${euro(b.value||0)}<span>Actif</span></div></div>
    <div class="gl4Native">
      <div><span>Grid Profit</span><b>${n?.grid!=null?num(n.grid)+' '+esc(n.unit):'—'}</b></div>
      <div><span>P&L latent</span><b>${n?.latent!=null?num(n.latent)+' '+esc(n.unit):'—'}</b></div>
      <div><span>Bénéfice courant</span><b>${n?.current!=null?num(n.current)+' '+esc(n.unit):'—'}</b></div>
    </div>
    <div class="gl4Foot">Métriques natives explicatives · jamais ajoutées automatiquement au réalisé${n?.date?' · '+esc(n.date):''}</div>
  </article>`;
}
function renderClosedCard(s,b){
  const r=realizedObs(s,b.id), sn=latest(botSnaps(s,b.id)), invest=sn?.investmentNative;
  return `<article class="gl4ClosedCard">
    <div><div class="gl4Platform">${esc(b.platform||'')}</div><b>${esc(b.name||'Bot fermé')}</b><div class="gl4Small">${esc(b.pair||'')} ${r?.date?'· '+esc(r.date):''}</div></div>
    <div class="gl4ClosedResult">${r?`<strong class="${r.eur>=0?'posTxt':'negTxt'}">${r.eur>=0?'+':''}${euro(r.eur)}</strong>${confidenceBadge(r.confidence)}`:'<strong>À compléter</strong>'}</div>
    ${invest!=null?`<div class="gl4Small gl4Wide">Capital historique documenté : ${num(invest)} ${esc(sn.nativeUnit||'')}</div>`:''}
  </article>`;
}
function dashboard(s){
  const totals=locationTotals(s),r=realizedSummary(s),t=tax(s),c=contributionInfo(s),q=quality(s);
  return `<section id="gl4Cockpit">
    <div class="gl4Hero">
      <div><div class="gl4Eyebrow">GRIDLEDGER v4 · VUE FIABLE</div><div class="gl4Label">Capital financier actuel</div><div class="gl4Capital">${euro(totals.total)}</div><div class="gl4HeroNote">Uniquement les positions actuellement détenues. Les anciens bots sont exclus.</div></div>
      <div class="gl4HeroSide"><span>Résultat net réalisé connu</span><b class="${r.net>=0?'posTxt':'negTxt'}">${r.net>=0?'+':''}${euro(r.net)}</b><small>Bots clôturés documentés</small></div>
    </div>
    <div class="gl4Kpis">
      <div><span>Bots actifs</span><b>${euro(totals.bot)}</b><small>${activeBots(s).length} actif(s)</small></div>
      <div><span>Long terme + réserve</span><b>${euro(totals.protectedValue)}</b><small>hors bots</small></div>
      <div class="gl4Partial"><span>Apports tracés</span><b>${euro(c.value)}</b><small>⚠ historique incomplet</small></div>
      <div><span>Gains clôturés</span><b class="posTxt">${euro(r.gain)}</b><small>avant pertes</small></div>
      <div><span>Pertes clôturées</span><b class="negTxt">${euro(r.loss)}</b><small>historique connu</small></div>
      <div><span>Net clôturé</span><b class="${r.net>=0?'posTxt':'negTxt'}">${euro(r.net)}</b><small>base de suivi</small></div>
    </div>
    <div class="gl4Grid">
      <div class="gl4Panel gl4Span2"><div class="gl4Head"><div><h2>Bots actifs</h2><p>Ce qui travaille actuellement</p></div><button data-go="bots">Détail</button></div><div class="gl4ActiveGrid">${activeBots(s).map(b=>renderActiveCard(s,b)).join('')||'<div class="gl4Empty">Aucun bot actif.</div>'}</div></div>
      <div class="gl4Panel"><div class="gl4Head"><div><h2>Prévision fiscale</h2><p>Sur gains nets réalisés connus</p></div></div>
        <div class="gl4Tax"><div><span>Base actuelle</span><b>${euro(t.base)}</b></div><div><span>Provision 10 %</span><b>${euro(t.t10)}</b></div><div><span>Provision 30 %</span><b>${euro(t.t30)}</b></div></div>
        <div class="gl4Legal">Prévisions uniquement, pas un calcul fiscal officiel. Aucun P&L latent n’est taxé ici.</div>
      </div>
      <div class="gl4Panel gl4Span2"><div class="gl4Head"><div><h2>Résultats réalisés par mois</h2><p>Clôtures documentées uniquement</p></div></div>${renderBars(realizedMonthly(s))}</div>
      <div class="gl4Panel"><div class="gl4Head"><div><h2>Contrôle des données</h2><p>Ce qu’il reste à fiabiliser</p></div></div><div class="gl4Quality">${q.slice(0,4).map(x=>`<div class="${x[2]}"><b>${esc(x[0])}</b><span>${esc(x[1])}</span></div>`).join('')}</div></div>
    </div>
    <div class="gl4Disclaimer">Le capital actuel, les résultats réalisés et les métriques natives sont volontairement séparés pour éviter tout double comptage.</div>
  </section>`;
}
function botsView(s){
  const active=activeBots(s),closed=closedBots(s);
  const mode=s.settings?.gl4BotMode==='CLOSED'?'CLOSED':'ACTIVE';
  return `<section id="gl4Bots">
    <div class="gl4BotsIntro"><div><div class="gl4Eyebrow">SUIVI SPOT GRID</div><h2>Mes bots</h2><p>Actifs d’abord. Les bots fermés restent archivés avec leur résultat.</p></div></div>
    <div class="gl4Tabs"><button data-gl4mode="ACTIVE" class="${mode==='ACTIVE'?'sel':''}">Actifs · ${active.length}</button><button data-gl4mode="CLOSED" class="${mode==='CLOSED'?'sel':''}">Fermés · ${closed.length}</button></div>
    <div class="${mode==='ACTIVE'?'gl4ActiveGrid':'gl4ClosedGrid'}">${(mode==='ACTIVE'?active.map(b=>renderActiveCard(s,b)):closed.map(b=>renderClosedCard(s,b))).join('')||'<div class="gl4Empty">Aucun bot.</div>'}</div>
  </section>`;
}
function hideLegacyDashboard(){
  const d=document.getElementById('dashboard');if(!d)return;
  [...d.children].forEach(el=>{if(el.id!=='gl4Cockpit')el.classList.add('gl4LegacyHidden')});
}
function hideLegacyBots(){
  const b=document.getElementById('bots');if(!b)return;
  [...b.children].forEach(el=>{if(el.id!=='gl4Bots')el.classList.add('gl4LegacyHidden')});
}
function bindNav(root){
  root.querySelectorAll('[data-go]').forEach(x=>x.onclick=()=>{
    const target=x.dataset.go;
    try{document.querySelector(`[data-screen="${target}"]`)?.click()}catch{}
  });
}
function render(){
  const s=state();if(!s)return;
  const d=document.getElementById('dashboard');
  if(d){
    let x=document.getElementById('gl4Cockpit');
    if(!x){x=document.createElement('div');x.id='gl4Cockpit';d.prepend(x)}
    x.outerHTML=dashboard(s);hideLegacyDashboard();bindNav(document.getElementById('gl4Cockpit'));
  }
  const b=document.getElementById('bots');
  if(b){
    let x=document.getElementById('gl4Bots');
    if(!x){x=document.createElement('div');x.id='gl4Bots';b.prepend(x)}
    x.outerHTML=botsView(s);hideLegacyBots();
    document.querySelectorAll('[data-gl4mode]').forEach(btn=>btn.onclick=async()=>{
      s.settings=s.settings||{};s.settings.gl4BotMode=btn.dataset.gl4mode;
      try{if(typeof saveState==='function')await saveState()}catch{}
      render();
    });
  }
}
function addStyle(){
 if(document.getElementById('gl4Style'))return;
 const st=document.createElement('style');st.id='gl4Style';st.textContent=`
 .gl4LegacyHidden{display:none!important}
 #gl4Cockpit,#gl4Bots{padding:0 0 110px;color:#23384a}
 #gl4Cockpit{background:#eef3f6}
 .gl4Hero{margin:0 24px 18px;padding:24px;border-radius:0 0 28px 28px;background:linear-gradient(145deg,#163954,#225f86);color:white;display:flex;justify-content:space-between;gap:18px}
 .gl4Eyebrow{font-size:.72rem;letter-spacing:.12em;opacity:.72;font-weight:800}
 .gl4Label{margin-top:12px;opacity:.82}.gl4Capital{font-size:2.8rem;line-height:1;font-weight:900;margin:5px 0}
 .gl4HeroNote{font-size:.8rem;opacity:.75;max-width:390px}.gl4HeroSide{align-self:flex-end;text-align:right;min-width:160px}
 .gl4HeroSide span,.gl4HeroSide small{display:block;font-size:.76rem;opacity:.78}.gl4HeroSide b{display:block;font-size:1.35rem;margin:4px 0}
 .gl4Kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 24px 16px}
 .gl4Kpis>div{background:white;border:1px solid #dbe3e8;border-radius:16px;padding:14px}.gl4Kpis span,.gl4Kpis small{display:block;color:#71808d;font-size:.78rem}.gl4Kpis b{display:block;font-size:1.12rem;margin:4px 0}.gl4Partial{border-style:dashed!important}
 .gl4Grid{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin:0 24px}.gl4Span2{grid-column:auto}
 .gl4Panel{background:white;border:1px solid #dbe3e8;border-radius:20px;padding:17px;min-width:0}
 .gl4Head{display:flex;justify-content:space-between;align-items:start;gap:8px;margin-bottom:12px}.gl4Head h2{font-size:1.05rem;margin:0}.gl4Head p{margin:3px 0 0;color:#71808d;font-size:.78rem}.gl4Head button{border:0;background:#e9f1f6;color:#1e5d85;border-radius:999px;padding:8px 12px;font-weight:800}
 .gl4ActiveGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.gl4Bot{border:1px solid #e1e7eb;border-radius:16px;padding:14px;background:#fbfcfd}
 .gl4BotTop{display:flex;justify-content:space-between;gap:8px}.gl4Bot h3{font-size:.98rem;margin:2px 0}.gl4Platform{font-size:.7rem;font-weight:900;letter-spacing:.06em;color:#4f7189;text-transform:uppercase}.gl4Pair,.gl4Small{font-size:.75rem;color:#71808d}
 .gl4BotValue{text-align:right;font-weight:900;white-space:nowrap}.gl4BotValue span{display:block;color:#28784a;font-size:.72rem;margin-top:3px}
 .gl4Native{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:12px}.gl4Native>div{background:#f0f4f7;border-radius:10px;padding:8px}.gl4Native span{display:block;color:#71808d;font-size:.66rem}.gl4Native b{display:block;font-size:.76rem;margin-top:3px}
 .gl4Foot,.gl4Legal,.gl4Disclaimer{color:#71808d;font-size:.72rem;line-height:1.4;margin-top:9px}
 .gl4Tax{display:grid;gap:7px}.gl4Tax>div{display:flex;justify-content:space-between;background:#f4f7f9;border-radius:11px;padding:10px}.gl4Tax span{color:#71808d;font-size:.78rem}
 .gl4Bars{display:grid;gap:9px}.gl4BarRow{display:grid;grid-template-columns:62px 1fr 90px;gap:8px;align-items:center;font-size:.74rem}.gl4BarTrack{height:9px;background:#edf1f3;border-radius:99px;overflow:hidden}.gl4BarTrack i{display:block;height:100%;border-radius:99px}.gl4BarTrack i.pos{background:#3a8b5b}.gl4BarTrack i.neg{background:#b85555}.gl4BarRow b{text-align:right}
 .posTxt{color:#28784a!important}.negTxt{color:#a64242!important}
 .gl4Quality{display:grid;gap:8px}.gl4Quality>div{padding:10px;border-radius:11px;background:#f5f7f8}.gl4Quality b,.gl4Quality span{display:block}.gl4Quality span{font-size:.73rem;color:#71808d;margin-top:2px}.gl4Quality .warn{border-left:4px solid #c6902e}.gl4Quality .ok{border-left:4px solid #3b8c5d}
 .gl4Disclaimer{margin:14px 24px;text-align:center}
 #gl4Bots{padding:18px 24px 110px}.gl4BotsIntro h2{font-size:1.5rem;margin:4px 0}.gl4BotsIntro p{color:#71808d;margin:0}
 .gl4Tabs{display:flex;gap:8px;margin:18px 0}.gl4Tabs button{border:0;border-radius:999px;background:#e5ebef;color:#345064;font-weight:900;padding:11px 16px}.gl4Tabs button.sel{background:#1d5a83;color:white}
 .gl4ClosedGrid{display:grid;gap:9px}.gl4ClosedCard{display:grid;grid-template-columns:1fr auto;gap:8px;border:1px solid #dfe6ea;background:white;border-radius:16px;padding:14px}.gl4ClosedResult{text-align:right}.gl4ClosedResult strong{display:block}.gl4Wide{grid-column:1/-1}
 .gl4Badge{display:inline-block;font-size:.65rem;padding:3px 6px;border-radius:99px;margin-top:4px}.gl4Badge.ok{background:#e3f2e8;color:#28784a}.gl4Badge.warn{background:#fff2d9;color:#8c651c}.gl4Badge.bad{background:#fde5e5;color:#a64242}
 .gl4Empty{padding:18px;color:#71808d;text-align:center}
 @media(max-width:760px){
   .gl4Hero{display:block}.gl4HeroSide{text-align:left;margin-top:18px}.gl4Kpis{grid-template-columns:repeat(2,1fr)}
   .gl4Grid{grid-template-columns:1fr}.gl4ActiveGrid{grid-template-columns:1fr}.gl4Native{grid-template-columns:1fr 1fr 1fr}
 }
 @media(max-width:390px){.gl4Kpis{grid-template-columns:1fr 1fr}.gl4Capital{font-size:2.35rem}.gl4BarRow{grid-template-columns:55px 1fr 78px}}
 `;document.head.appendChild(st);
}
let sig='';
function tick(){
 addStyle();const s=state();if(!s)return;
 const next=JSON.stringify({u:s.updated,nb:(s.bots||[]).length,ns:(s.snapshots||[]).length,no:(s.observations||[]).length,nm:(s.movements||[]).length,mode:s.settings?.gl4BotMode,vals:(s.bots||[]).map(b=>[b.id,b.value,b.status])});
 if(next!==sig||!document.getElementById('gl4Cockpit')){sig=next;render()}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{setInterval(tick,1000);tick()},{once:true});else{setInterval(tick,1000);tick()}
})();