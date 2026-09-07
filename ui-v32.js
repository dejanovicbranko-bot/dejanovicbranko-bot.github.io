(() => {
'use strict';

// GridLedger v3.2 UI patch.
// No personal figures are embedded: everything is read from the encrypted local state
// synchronized from GridLedger Cloud.

const euro = v => Number(v||0).toLocaleString('fr-BE',{style:'currency',currency:'EUR'});
const num = v => Number(v||0).toLocaleString('fr-BE',{maximumFractionDigits:2});
const esc = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function st(){ try{return typeof currentState!=='undefined'?currentState:null}catch{return null} }
function snapDate(x){ return x?.capturedAt||x?.date||''; }
function latestSnapshot(s,botId){
  return (s.snapshots||[]).filter(x=>x.botId===botId).slice()
    .sort((a,b)=>String(snapDate(b)).localeCompare(String(snapDate(a))))[0]||null;
}
function realizedObservation(s,botId){
  const rows=(s.observations||[]).filter(o =>
    o.botId===botId &&
    (String(o.id||'').startsWith('realized-gain-eur-') || String(o.id||'').startsWith('realized-loss-eur-'))
  );
  if(!rows.length)return null;
  const o=rows.slice().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')))[0];
  const loss=String(o.id||'').startsWith('realized-loss-eur-');
  return {...o,signedValue:loss?-Number(o.value||0):Number(o.value||0)};
}
function taxBase(s){
  const rows=new Map();
  for(const o of s.observations||[]){
    const old=rows.get(o.id);
    if(!old||String(o.updatedAt||o.observedAt||o.createdAt||'')>=String(old.updatedAt||old.observedAt||old.createdAt||''))rows.set(o.id,o);
  }
  return [...rows.values()].reduce((a,o)=>{
    const bots=(s.bots||[]).filter(b=>o.botId?b.id===o.botId:o.locationId&&b.locationId===o.locationId);
    if(bots.length!==1||bots[0].status!=='CLOSED'||o.confidence!=='CERTAIN')return a;
    if(!(typeof o.value==='number'||typeof o.value==='string'&&o.value.trim()!=='')||!Number.isFinite(Number(o.value)))return a;
    const id=String(o.id||''),value=Math.abs(Number(o.value));
    if(id.startsWith('realized-gain-eur-'))return a+value;
    if(id.startsWith('realized-loss-eur-'))return a-value;
    return a;
  },0);
}
function botCard(s,b,closed=false){
  const sn=latestSnapshot(s,b.id);
  const rr=closed?realizedObservation(s,b.id):null;
  const native=sn?.nativeUnit||'';
  const gp=sn?.gridProfitNative;
  const lp=sn?.latentNative;
  const cp=sn?.currentProfitNative;
  const bits=[];
  if(closed && rr){
    bits.push(`<div class="gl32Result ${rr.signedValue>=0?'pos':'neg'}">Résultat réalisé : ${rr.signedValue>=0?'+':''}${euro(rr.signedValue)}</div>`);
  }else if(closed){
    bits.push(`<div class="gl32Muted">Résultat EUR à vérifier / compléter</div>`);
  }
  if(gp!==null&&gp!==undefined) bits.push(`<div class="gl32Muted">Grid Profit : ${num(gp)} ${esc(native)}</div>`);
  if(!closed && cp!==null&&cp!==undefined) bits.push(`<div class="gl32Muted">Bénéfice courant : ${num(cp)} ${esc(native)} · non réalisé</div>`);
  if(!closed && lp!==null&&lp!==undefined) bits.push(`<div class="gl32Muted">P&L latent : ${num(lp)} ${esc(native)} · non réalisé</div>`);
  return `<div class="gl32BotCard">
    <div>
      <b>${esc(b.name||'Bot')}</b>
      <div class="gl32Muted">${esc(b.platform||'')} · ${esc(b.pair||'')}</div>
      ${bits.join('')}
    </div>
    <div class="gl32Right">
      ${closed?'<span class="gl32Closed">Fermé</span>':`<b>${euro(b.value||0)}</b><span class="gl32Active">Actif</span>`}
    </div>
  </div>`;
}

function renderBots(){
  if(document.getElementById('gl4Bots'))return;
  const s=st(), host=document.getElementById('bots');
  if(!s||!host)return;

  let shell=document.getElementById('glBotsV32');
  if(!shell){
    const existing=[...host.children];
    shell=document.createElement('section');
    shell.id='glBotsV32';

    const details=document.createElement('details');
    details.id='glBotsLegacy';
    details.innerHTML='<summary>Gestion avancée / ancienne vue</summary><div id="glBotsLegacyBody"></div>';
    const body=details.querySelector('#glBotsLegacyBody');
    existing.forEach(el=>body.appendChild(el));

    host.appendChild(shell);
    host.appendChild(details);
  }

  const active=(s.bots||[]).filter(b=>b.status!=='CLOSED' && b.value>0);
  const closed=(s.bots||[]).filter(b=>b.status==='CLOSED');
  const mode=s.settings?.botViewMode==='CLOSED'?'CLOSED':'ACTIVE';

  shell.innerHTML=`
    <div class="gl32TitleRow">
      <div><h2>Bots</h2><div class="gl32Muted">Les bots actifs sont affichés en premier. Les bots fermés restent dans l'historique.</div></div>
    </div>
    <div class="gl32Tabs">
      <button data-gl32-tab="ACTIVE" class="${mode==='ACTIVE'?'sel':''}">Bots actifs (${active.length})</button>
      <button data-gl32-tab="CLOSED" class="${mode==='CLOSED'?'sel':''}">Bots fermés (${closed.length})</button>
    </div>
    <div>${(mode==='ACTIVE'?active:closed).map(b=>botCard(s,b,mode==='CLOSED')).join('') || '<div class="gl32Empty">Aucun bot dans cette catégorie.</div>'}</div>
  `;
  shell.querySelectorAll('[data-gl32-tab]').forEach(btn=>btn.onclick=async()=>{
    s.settings=s.settings||{};
    s.settings.botViewMode=btn.dataset.gl32Tab;
    try{ if(typeof saveState==='function') await saveState(); }catch{}
    renderBots();
  });
}

function renderTax(){
  if(document.getElementById('gl4Cockpit'))return;
  const s=st(), host=document.getElementById('dashboard');
  if(!s||!host)return;
  let box=document.getElementById('glTaxForecastV32');
  if(!box){
    box=document.createElement('section');
    box.id='glTaxForecastV32';
    const after=document.getElementById('glHistoricalResults');
    if(after?.parentNode===host) after.insertAdjacentElement('afterend',box);
    else host.appendChild(box);
  }
  const net=taxBase(s);
  const taxable=Math.max(net,0);
  box.innerHTML=`
    <h2>Prévisions fiscales sur gains réalisés</h2>
    <div class="gl32Muted">Scénarios de provision uniquement. Ce n'est pas un calcul fiscal officiel. Les P&L latents et les bots encore actifs ne sont pas inclus.</div>
    <div class="gl32TaxGrid">
      <div><span>Gains nets réalisés connus</span><b>${euro(net)}</b></div>
      <div><span>Prévision 10 %</span><b>${euro(taxable*0.10)}</b></div>
      <div><span>Prévision 30 %</span><b>${euro(taxable*0.30)}</b></div>
    </div>
  `;
}

function clarifyIncompleteAccounting(){
  const root=document.getElementById('dashboard');
  if(!root)return;
  const walkers=[...root.querySelectorAll('*')];
  for(const el of walkers){
    if(el.children.length)continue;
    const t=(el.textContent||'').trim();
    if(t==='Apports extérieurs') el.textContent='Apports tracés (partiel)';
    if(t.includes('de performance économique') && !t.includes('partielle')){
      el.textContent=t.replace('de performance économique','de performance partielle · apports historiques à compléter');
    }
  }
}

function style(){
  if(document.getElementById('glV32Style'))return;
  const x=document.createElement('style');x.id='glV32Style';x.textContent=`
    #glBotsV32,#glTaxForecastV32{margin:16px 24px;padding:18px;border:1px solid #d8e0e8;border-radius:18px;background:#fff;color:#24384a}
    #glBotsV32 h2,#glTaxForecastV32 h2{margin:0 0 6px;font-size:1.25rem}
    .gl32Muted{color:#71808d;font-size:.84rem;line-height:1.4}
    .gl32Tabs{display:flex;gap:8px;margin:14px 0}
    .gl32Tabs button{border:0;border-radius:999px;padding:10px 14px;font-weight:700;background:#e8eef3;color:#294257}
    .gl32Tabs button.sel{background:#1f5b85;color:white}
    .gl32BotCard{display:flex;justify-content:space-between;gap:12px;padding:14px 0;border-top:1px solid #e7ecef}
    .gl32BotCard:first-child{border-top:0}
    .gl32Right{text-align:right;min-width:95px}
    .gl32Right span{display:block;margin-top:6px;font-size:.78rem;font-weight:700}
    .gl32Active{color:#247247}.gl32Closed{color:#71808d}
    .gl32Result{font-weight:800;margin-top:6px}.gl32Result.pos{color:#247247}.gl32Result.neg{color:#a43b3b}
    #glBotsLegacy{margin:8px 24px 20px;color:#617383}
    #glBotsLegacy summary{cursor:pointer;font-weight:700;padding:10px 0}
    .gl32TaxGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
    .gl32TaxGrid>div{background:#f5f8fa;border-radius:12px;padding:12px}
    .gl32TaxGrid span{display:block;color:#71808d;font-size:.82rem}.gl32TaxGrid b{display:block;margin-top:4px;font-size:1.05rem}
    .gl32Empty{padding:14px 0;color:#71808d}
    @media(max-width:560px){.gl32TaxGrid{grid-template-columns:1fr}#glBotsV32,#glTaxForecastV32{margin:14px 24px}}
  `;document.head.appendChild(x);
}

function tick(){
  style();
  renderBots();
  renderTax();
  clarifyIncompleteAccounting();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setInterval(tick,1200),{once:true});
else setInterval(tick,1200);
setTimeout(tick,300);
})();