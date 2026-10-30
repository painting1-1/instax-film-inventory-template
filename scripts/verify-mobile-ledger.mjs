// Run after npm run build. Exercises real ledger markup and delegated swipe gestures.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import * as core from '../dist/client/core.mjs';
import { shortLedgerDate, ledgerUseUnitCost, initLedgerSwipe } from '../dist/client/mobile-ledger.mjs';
assert.equal(shortLedgerDate('2026-10-05'), '26/10/5');
assert.equal(shortLedgerDate('2027-08', true), '27/8');
assert.equal(shortLedgerDate(''), '');
const state = core.normalizeState({products:[
 {id:'f',category:'相纸',series:'Mini',model:'粉边',capacity:10},
 {id:'c',category:'相机',model:'Mini25',spec:'helloKitty联名',capacity:1},
],transactions:[
 {id:'p',type:'purchase',productId:'f',lotId:'film1',date:'2026-10-05',expiry:'2027-08',quantity:2,unitPrice:65},
 {id:'u',type:'use',productId:'f',lotId:'film1',date:'2026-10-16',expiry:'2027-08',quantity:0.5,unitPrice:0},
 {id:'pc',type:'purchase',productId:'c',lotId:'cam1',date:'2026-10-05',quantity:1,unitPrice:1250},
 {id:'uc',type:'use',productId:'c',lotId:'cam1',date:'2026-10-13',quantity:1,unitPrice:0},
]});
assert.equal(ledgerUseUnitCost(state,state.transactions[1]),65);
assert.equal(ledgerUseUnitCost(state,{productId:'f',lotId:'missing'}),null);
const { window }=parseHTML(await readFile(new URL('../dist/client/index.html',import.meta.url),'utf8'));
const { document }=window;
for(const id of ['ledgerSearch','ledgerCategory','ledgerSeries','ledgerExpiry']) Object.defineProperty(document.getElementById(id),'value',{value:'',writable:true});
const source=await readFile(new URL('../dist/client/app.js',import.meta.url),'utf8');
const start=source.indexOf('function renderLedger(result)');
const end=source.indexOf('\nfunction ',start+1);
const formatDate=value=>value.replace(/-/g,'/');
const context={state,transactionType:'全部',selectedTransactionIds:new Set(),$:s=>document.querySelector(s),
 getProduct:id=>state.products.find(p=>p.id===id),...core,shortLedgerDate,ledgerUseUnitCost,
 updateLedgerToolbar:()=>{},renderSavedLists:()=>{},renderSelectionSummary:()=>{},escapeHtml:String,numberText:String,
 formatDate,formatExpiry:String,platformMarkup:String,productSubline:()=>'',
 productName:p=>[p.series,p.model,p.spec].filter(Boolean).join(' · '),
 productVisual:()=>'<span class="product-visual ledger-visual">▧</span>'};
vm.runInNewContext(source.slice(start,end)+';renderLedger',context)(core.calculateInventory(state));
const list=document.getElementById('ledgerList');
assert.equal(list.querySelectorAll('.ledger-face').length,4);
assert.match(list.querySelector('[data-transaction-id="p"] .ledger-date .ledger-mobile').textContent,/购入 26\/10\/5/);
assert.equal(list.querySelector('[data-transaction-id="p"] .ledger-batch .ledger-mobile').textContent,'27/8');
assert.match(list.querySelector('[data-transaction-id="u"] .ledger-unit-price .ledger-mobile').textContent,/65.*\/盒/);
assert.equal(list.querySelector('[data-transaction-id="pc"] .ledger-batch .ledger-mobile').textContent,'');
window.matchMedia=()=>({matches:true,addEventListener(){}});
list.querySelectorAll('.ledger-actions').forEach(el=>el.getBoundingClientRect=()=>({width:el.children.length*56}));
initLedgerSwipe(list,window);
const rows=[...list.querySelectorAll('.ledger-row:not(.header)')];
const first=rows[0],second=rows[1];
const point=(target,type,x,y)=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:1,clientX:x,clientY:y,button:0,isPrimary:true});target.dispatchEvent(event);};
const swipe=async(row,dx,dy=0)=>{const face=row.querySelector('.ledger-face');point(face,'pointerdown',250,80);point(face,'pointermove',250+dx,80+dy);point(face,'pointerup',250+dx,80+dy);await new Promise(r=>setTimeout(r,1));};
assert.equal(first.querySelector('.ledger-actions').getAttribute('aria-hidden'),'true');
await swipe(first,-140);
assert.ok(first.classList.contains('swipe-open'));
assert.equal(first.querySelector('.ledger-actions').getAttribute('aria-hidden'),'false');
await swipe(second,-140);
assert.ok(!first.classList.contains('swipe-open'));
assert.ok(second.classList.contains('swipe-open'));
second.querySelector('.ledger-face').click();
assert.ok(!second.classList.contains('swipe-open'));
await swipe(first,-15,100);
assert.ok(!first.classList.contains('swipe-open'));
await swipe(first,-140);
await swipe(first,160);
assert.ok(!first.classList.contains('swipe-open'));
await swipe(first,-140);
window.dispatchEvent(new window.Event('scroll'));
assert.ok(!first.classList.contains('swipe-open'));
let deletes=0;
list.addEventListener('click',event=>{if(event.target.closest('[data-delete]'))deletes++;});
await swipe(first,-140);
assert.equal(deletes,0);
first.querySelector('[data-delete]').click();
assert.equal(deletes,1);
assert.ok(!first.classList.contains('swipe-open'));
console.log('Mobile ledger markup, date/expiry/cost and horizontal/vertical/click/scroll gestures passed.');
if(process.argv.includes('--preview')){
 const dir=new URL('../qa-preview/',import.meta.url);await mkdir(new URL('.openai/',dir),{recursive:true});
 await mkdir(new URL('dist/',dir),{recursive:true});
 await writeFile(new URL('.openai/hosting.json',dir),JSON.stringify({static:{directory:'dist'}}));
 await cp(new URL('../dist/client/styles.css',import.meta.url),new URL('dist/styles.css',dir));
 for(const name of ['core.mjs','mobile-ledger.mjs'])await cp(new URL('../dist/client/'+name,import.meta.url),new URL('dist/'+name,dir));
 await writeFile(new URL('dist/index.html',dir),'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>main{max-width:1100px;margin:auto;padding:16px}.ledger-visual{background:#e8ede5;font-size:24px;display:grid;place-items:center}</style><main><h2>流水布局检查</h2><p class="ledger-swipe-hint">左滑可操作</p>'+list.outerHTML+'</main><script type="module">import{initLedgerSwipe}from"./mobile-ledger.mjs";initLedgerSwipe(document.getElementById("ledgerList"));</script>');
}
