import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({
  resolve(s,c,next) {
    if (s.endsWith('/freshdesk-scope.js') || s.endsWith('/process-ticket.js') || s.endsWith('/backfill.js') || s==='@vercel/functions') return {url:'mock:background',shortCircuit:true};
    return next(s,c);
  },
  load(url,c,next) {
    if(url==='mock:background') return {format:'module',shortCircuit:true,source:`
      export async function checkFreshdeskScope(){return {allowed:true};}
      export async function processScopedTicket(){throw Error('not expected');}
      export function backfillBatch(){return {runId:'fixture',batch:1};}
      export function runBackfill(){globalThis.started++;return globalThis.job;}
      export function waitUntil(p){globalThis.pending=p;}
    `};
    return next(url,c);
  }
});
const {default:handler}=await import('../api/freshdesk/intake.js');
test('batch acknowledges before job completes and registers its lifetime',async()=>{
 process.env.WEBHOOK_SECRET='fixture';globalThis.started=0;
 let finish;globalThis.job=new Promise(r=>finish=r);
 const req={method:'POST',headers:{'x-chubby-webhook-secret':'fixture'},body:{ticket_id:'123'}};
 const res={status(n){this.code=n;return this},setHeader(){},send(s){this.body=JSON.parse(s)}};
 await handler({...req,headers:{}},res);assert.equal(started,0);assert.equal(res.code,401);
 await handler(req,res);assert.equal(started,1);assert.equal(res.code,200);assert.equal(res.body.status,'backfill_batch_accepted');
 assert.ok(pending instanceof Promise);finish({outcomes:[{}],actionTaken:false});await pending;
});
