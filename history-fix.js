(() => {
'use strict';

// GridLedger v3.1 UI patch.
// Historical values remain sourced from GridLedger Cloud/local state.
// No personal financial figures are embedded in this public file.

const eur=v=>Number(v||0).toLocaleString('fr-BE',{style:'currency',currency:'EUR'});
const n=v=>Number(v||0).toLocaleString('fr-BE',{maximumFractionDigits:2});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function getState(){try{return typeof currentState!=='undefined'?currentState:null}catch{return null}}
function snaps(s,id){return (s.snapshots||[]).filter(x=>x.botId===id)}
function latest(s,id){
  return snaps(s,id).slice().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||String(b.capturedAt||'').localeCompare(String(a.capturedAt||'')))[0]||null;
}
function closedRows(s){
  return (s.bots||[]).filter(b=>b.status==='CLOSED').map(b=>{
    const ss=snaps(s,b.id).filter(x=>x.currentProfitNative!==null&&x.currentProfitNative!==undefined);
    const x=ss.slice().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')))[0];
    return x?{b,x}:null;
  }).filter(Boolean);
}
function render(){
  const s=getState(),host=document.getElementById('dashboard');
  if(!s||!host)return;
  let box=document.getElementById('glHistoryV31');
  if(!box){box=document.createElement('section');box.id='glHistoryV31';host.insertBefore(box,host.firstChild?.nextSibling||host.firstChild)}
  const rows=closedRows(s);
  box.innerHTML=`<style>
  #glHistoryV31{margin:16px 24px;padding:18px;border:1px solid #d8e0e8;border-radius:18px;background:#fff;color:#24384a}
  #glHistoryV31 h2{margin:0 0 8px;font-size:1.2rem}
  #glHistoryV31 .muted{color:#71808d;font-size:.84rem;line-height:1.4}
  #glHistoryV31 .row{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid #e7ecef}
  #glHistoryV31 .right{text-align:right;font-weight:700}
  </style>
  <h2>Historique des résultats</h2>
  <div class="muted">Les bots fermés restent des archives : leur valeur actuelle est 0 €, mais leur résultat de clôture est conservé. Les conversions EUR viennent des snapshots Cloud et ne sont jamais ajoutées au capital actuel.</div>
  ${rows.map(({b,x})=>`<div class="row"><div><b>${esc(b.name)}</b><div class="muted">${esc(x.date||'')} · ${n(x.currentProfitNative)} ${esc(x.nativeUnit||'')}</div></div><div class="right">${x.currentValueEUR!==null&&x.currentValueEUR!==undefined?'Valeur historique '+eur(x.currentValueEUR):'Résultat historique'}</div></div>`).join('')}
  `;
}
setInterval(render,1500);
setTimeout(render,300);
})();