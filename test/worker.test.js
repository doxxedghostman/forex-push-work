import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import worker, { drain } from '../src/index.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
  FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({client_email:'test@test.iam.gserviceaccount.com', private_key:privateKey.export({type:'pkcs8',format:'pem'}),project_id:'forex-test'}),
  PUSH_WEBHOOK_SECRET: 'long-test-secret',
};
const originalFetch = globalThis.fetch;
const originalCrypto = globalThis.crypto;
globalThis.crypto ??= webcrypto;

function fetchMock(jobs, log, fcmCode = 200) {
  return async (input, init = {}) => {
    const url=String(input);
    log.push({url,method:init.method??'GET',body:init.body});
    if(url==='https://oauth2.googleapis.com/token') return Response.json({access_token:'test-access',expires_in:3600});
    if(url.includes('/rpc/claim_pending_push_jobs')) return Response.json(jobs);
    if(url.includes('/rest/v1/push_delivery_jobs?'))return Response.json(jobs.map(j=>({id:j.id,user_id:'123e4567-e89b-12d3-a456-426614174000',channel_id:'trade-alerts-v4',action_url:'/alerts'})));
    if(url.includes('/rest/v1/push_devices?'))return Response.json([{id:'device1'}]);
    if(url.includes('/rpc/record_push_delivery_outcome'))return Response.json(true);
    if(url.includes('fcm.googleapis.com/'))return fcmCode===200?Response.json({name:'projects/forex-test/messages/1'}):Response.json({error:{status:'UNAVAILABLE'}},{status:fcmCode});
    throw Error('Unexpected request '+url);
  };
}

test('unauthorized webhook never claims jobs',async()=>{
  const log=[];globalThis.fetch=fetchMock([],log);
  const response=await worker.fetch(new Request('https://push.example/wake',{method:'POST'}),env,{});
  assert.equal(response.status,401);assert.equal(log.length,0);
});

test('valid wake sends job via FCM and records accepted outcome',async()=>{
  const log=[];
  globalThis.fetch=fetchMock([{id:'11111111-1111-4111-8111-111111111111',push_token:'validtoken',title:'Trade',message:'Reached',attempts:1}],log);
  const response=await worker.fetch(new Request('https://push.example/wake',{method:'POST',headers:{'x-webhook-secret':env.PUSH_WEBHOOK_SECRET}}),env,{});
  assert.equal(response.status,200);
  assert.equal((await response.json()).sent,1);
  const fcm=log.find(x=>x.url.includes('fcm.googleapis.com/'));
  assert.ok(fcm);
  assert.equal(JSON.parse(fcm.body).message.android.notification.channel_id,'trade-alerts-v4');
  const outcome=log.find(x=>x.url.includes('/rpc/record_push_delivery_outcome'));
  assert.equal(JSON.parse(outcome.body).p_status,'sent');
});

test('transient FCM failure becomes pending with reason',async()=>{
  const log=[];
  globalThis.fetch=fetchMock([{id:'22222222-2222-4222-8222-222222222222',push_token:'validtoken',title:'Trade',message:'Reached',attempts:1}],log,503);
  const result=await drain(env);
  assert.equal(result.retryable,1);
  const outcome=log.find(x=>x.url.includes('/rpc/record_push_delivery_outcome'));
  assert.equal(JSON.parse(outcome.body).p_status,'pending');
  assert.equal(JSON.parse(outcome.body).p_reason_code,'UNAVAILABLE');
});

test('invalid Firebase configuration does not claim jobs',async()=>{
  const log=[];globalThis.fetch=fetchMock([],log);
  await assert.rejects(drain({...env,FIREBASE_SERVICE_ACCOUNT_KEY:''}),{code:'FCM_CREDENTIALS_MISSING'});
  assert.equal(log.length,0);
});

test('scheduled execution shares drain codepath',async()=>{
  const log=[];globalThis.fetch=fetchMock([],log);
  await worker.scheduled({},env,{});
  assert.ok(log.some(x=>x.url.includes('/rpc/claim_pending_push_jobs')));
});

test.after(()=>{globalThis.fetch=originalFetch;if(!originalCrypto)delete globalThis.crypto;});
