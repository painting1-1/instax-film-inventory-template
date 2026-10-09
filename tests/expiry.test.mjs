import test from "node:test";
import assert from "node:assert/strict";
import { normalizeState, calculateInventory, transactionExpiryStatus, matchesExpiryFilter } from "../src/core.mjs";
const input = { products: [{id:"f", category:"相纸", series:"Mini", capacity:10}, {id:"c",category:"相机"}], transactions:[
{id:"p",productId:"f",lotId:"A",date:"2026-05-01",type:"purchase",quantity:2,unitPrice:50,expiryStatus:"unknown"},
{id:"s",productId:"f",lotId:"A",date:"2026-05-02",type:"sale",quantity:2,unitPrice:70},
{id:"new",productId:"f",lotId:"B",date:"2026-06-01",type:"purchase",quantity:1,unitPrice:50},
{id:"cam",productId:"c",date:"2026-01-01",type:"purchase",quantity:1},
{id:"known",productId:"f",lotId:"D",date:"2026-01-01",type:"purchase",quantity:1,expiry:"2027-01",expiryStatus:"unknown"}
]};
test("未知状态跨JSON和normalize保留；已知日期优先",()=>{
 const state=normalizeState(JSON.parse(JSON.stringify(input)));
 assert.equal(state.transactions[0].expiryStatus,"unknown");
 assert.equal(transactionExpiryStatus(state,state.transactions[1]),"unknown");
 assert.equal(transactionExpiryStatus(state,state.transactions[4]),"known");
});
test("待补与未知筛选互斥，不包括相机；空筛选保留所有",()=>{
 const state=normalizeState(input);
 assert.deepEqual(state.transactions.filter(tx=>matchesExpiryFilter(state,tx,"__pending")).map(tx=>tx.id),["new"]);
 assert.deepEqual(state.transactions.filter(tx=>matchesExpiryFilter(state,tx,"__unknown")).map(tx=>tx.id),["p","s"]);
 assert.equal(state.transactions.filter(tx=>matchesExpiryFilter(state,tx,"")).length,5);
 assert.deepEqual(state.transactions.filter(tx=>matchesExpiryFilter(state,tx,"2027-01")).map(tx=>tx.id),["known"]);
});
