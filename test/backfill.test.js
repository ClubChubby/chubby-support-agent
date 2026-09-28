import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  resolve(s,c,next) {
    if (s.endsWith('/freshdesk-scope.js')) return {url:'mock:scope-backfill',shortCircuit:true};
    if (s.endsWith('/process-ticket.js')) return {url:'mock:process-backfill',shortCircuit:true};
    return next(s,c);
  },
  load(url,c,next) {
    if (url==='mock:scope-backfill') return {format:'module',shortCircuit:true,source:`export async function checkFreshdeskScope(id,revision,options) { globalThis.scopes.push({id,options});return globalThis.scopeResult; }`};
    if (url==='mock:process-backfill') return {format:'module',shortCircuit:true,source:`export async function processScopedTicket(scope,options) { globalThis.processes.push(options); return {body:{status:'coupon_applied',actionTaken:true,email:'private@example.com',stripeCustomer:{id:'cus_private'}}}; }`};
    return next(url,c);
  }
});
const {backfillBatch,runBackfill}=await import('../lib/backfill.js');
let config,scope;
beforeEach(()=>{
  process.env.VERCEL_ENV='production';process.env.CHUBBY1_APPLICATION_MODE='live';
  config={runId:'a'.repeat(32),requesterId:'99',expiresAt:Date.now()+3600000,ticketIds:Array.from({length:26},(_,i)=>String(i+1))};
  process.env.CHUBBY1_BACKFILL=JSON.stringify(config);
  scope={allowed:true,requesterId:99,body:{subject:`CHUBBY1 BACKFILL ${config.runId} BATCH 1`}};
  globalThis.scopes=[];globalThis.processes=[];
  globalThis.scopeResult={allowed:true,body:{subject:'CHUBBY1'},revision:'fixture'};
});
test('frozen configured targets paginate; ticket cannot supply its own targets',()=>{
  scope.body.ticketIds=['9000'];
  assert.deepEqual(backfillBatch(scope).ids,config.ticketIds.slice(0,25));
  scope.body.subject=`CHUBBY1 BACKFILL ${config.runId} BATCH 2`;
  assert.deepEqual(backfillBatch(scope).ids,['26']);
  scope.body.subject=`CHUBBY1 BACKFILL ${config.runId} BATCH 3`;
  assert.equal(backfillBatch(scope),null);
});
test('expired, malformed, excessive and duplicate target configurations reject',()=>{
  for(const c of [null,{...config,expiresAt:Date.now()-1},{...config,expiresAt:Date.now()+86400000},
    {...config,ticketIds:['1','1']},{...config,ticketIds:['../accounts']},
    {...config,ticketIds:Array.from({length:301},(_,i)=>String(i+1))}]){
    process.env.CHUBBY1_BACKFILL=JSON.stringify(c); assert.equal(backfillBatch(scope),null);
  }
});
test('untrusted requester, disallowed scope, wrong run, preview and pilot cannot launch',()=>{
  assert.equal(backfillBatch({...scope,requesterId:100}),null);
  assert.equal(backfillBatch({...scope,allowed:false}),null);
  assert.equal(backfillBatch({...scope,body:{subject:'CHUBBY1 BACKFILL '+ 'b'.repeat(32)+' BATCH 1'}}),null);
  process.env.VERCEL_ENV='preview';assert.equal(backfillBatch(scope),null);
  process.env.VERCEL_ENV='production';process.env.CHUBBY1_APPLICATION_MODE='pilot';assert.equal(backfillBatch(scope),null);
});
test('every target checks current open status and Cody scope; blocked and synthetic tickets never process',async()=>{
  const batch={...backfillBatch(scope),ids:['1']};
  for(const result of [{allowed:false,status:'skipped',reason:'cody_already_replied'},
    {allowed:false,status:'skipped',reason:'ticket_not_open'},
    {allowed:true,body:{subject:'AGENTTEST'}}]){
    scopeResult=result;await runBackfill(batch);
  }
  assert.equal(processes.length,0);
  assert.ok(scopes.every(s=>s.options.requireOpen===true));
});
test('shared processor retains open recheck/expiry and never permits pilot exception; result is redacted',async()=>{
  const batch={...backfillBatch(scope),ids:['1']};
  const result=await runBackfill(batch);
  assert.equal(processes[0].requireOpen,true);
  assert.ok(processes[0].expiresAt <= batch.expiresAt);
  assert.ok(processes[0].expiresAt <= Date.now()+220000);
  assert.notEqual(processes[0].allowPilotException,true);
  assert.equal(result.actionTaken,true);
  assert.equal(JSON.stringify(result).includes('private'),false);
});
test('expiry or kill switch prevents any target lookup',async()=>{
  await runBackfill({...backfillBatch(scope),expiresAt:Date.now()-1});
  const batch=backfillBatch(scope);process.env.CHUBBY1_APPLICATION_MODE='';await runBackfill(batch);
  assert.equal(scopes.length,0);assert.equal(processes.length,0);
});

test('operator can reduce batch size without allowing ticket-controlled targets',()=>{
  config.batchSize=5;process.env.CHUBBY1_BACKFILL=JSON.stringify(config);
  scope.body.subject=`CHUBBY1 BACKFILL ${config.runId} BATCH 2`;
  assert.deepEqual(backfillBatch(scope).ids,['6','7','8','9','10']);
  for(const batchSize of [0,26,1.5,'5']) {
    process.env.CHUBBY1_BACKFILL=JSON.stringify({...config,batchSize});assert.equal(backfillBatch(scope),null);
  }
});
