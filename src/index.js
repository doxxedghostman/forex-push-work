// ForexVerse central FCM sender. No alert detection or market fetching.
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;
const PARALLELISM = 8;
const encoder = new TextEncoder();
let cachedAccessToken;

export class DeliveryError extends Error {
  constructor(code, retryable = true) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

function safePath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\r\n]/.test(value)
    ? value : '/notifications';
}

function credential(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_KEY) throw new DeliveryError('FCM_CREDENTIALS_MISSING', false);
  let service;
  try { service = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY); }
  catch { throw new DeliveryError('FCM_CREDENTIALS_INVALID', false); }
  if (!service?.client_email || !service?.private_key) throw new DeliveryError('FCM_CREDENTIALS_INVALID', false);
  return service;
}

function settings(env) {
  if (!env.SUPABASE_URL || !/^https:\/\//.test(env.SUPABASE_URL) || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new DeliveryError('SUPABASE_CONFIG_MISSING', false);
  }
  const service = credential(env);
  // Prefer an explicit ID, but the service account also knows its project.
  const project = env.FIREBASE_PROJECT_ID || service.project_id;
  if (!project || !/^[a-zA-Z0-9-]+$/.test(project)) throw new DeliveryError('FCM_PROJECT_MISSING', false);
  return { service, project };
}

async function rpc(env, name, body) {
  let response;
  try {
    response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new DeliveryError('DATABASE_NETWORK'); }
  if (!response.ok) throw new DeliveryError(`DATABASE_HTTP_${response.status}`);
  return response.json();
}

async function rows(env, table, query) {
  let response;
  try {
    response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?${query}`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new DeliveryError('DATABASE_NETWORK'); }
  if (!response.ok) throw new DeliveryError(`DATABASE_HTTP_${response.status}`);
  return response.json();
}

async function patch(env, table, query, payload) {
  let response;
  try {
    response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?${query}`, {
      method: 'PATCH', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new DeliveryError('DATABASE_NETWORK'); }
  if (!response.ok) throw new DeliveryError(`DATABASE_HTTP_${response.status}`);
}

function b64url(data) {
  const bytes = new Uint8Array(data);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function googleToken(service) {
  if (cachedAccessToken && cachedAccessToken.until > Date.now() + 60000 && cachedAccessToken.email === service.client_email) return cachedAccessToken.value;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: service.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const header = b64url(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const keyBytes = Uint8Array.from(atob(service.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0));
  let key;
  try { key = await crypto.subtle.importKey('pkcs8', keyBytes, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']); }
  catch { throw new DeliveryError('FCM_CREDENTIALS_INVALID', false); }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${payload}`));
  let response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:`${header}.${payload}.${b64url(sig)}` }),
      signal:AbortSignal.timeout(12000),
    });
  } catch { throw new DeliveryError('FCM_AUTH_NETWORK'); }
  if (!response.ok) throw new DeliveryError('FCM_AUTH_REJECTED', response.status >= 500 || response.status === 429);
  const result = await response.json();
  if (!result.access_token) throw new DeliveryError('FCM_AUTH_EMPTY');
  cachedAccessToken = { value:result.access_token, until:Date.now() + Math.max(60, result.expires_in ?? 3600)*1000, email: service.client_email };
  return cachedAccessToken.value;
}

async function deliver(env, project, accessToken, job, detail) {
  const path = safePath(detail.action_url);
  const channel = detail.channel_id || 'trade-alerts-v3';
  let response;
  try {
    response = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
      method:'POST', headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(10000),
      body:JSON.stringify({message:{token:job.push_token, notification:{title:job.title,body:job.message},
        data:{url:path}, webpush:{notification:{icon:'/logo.png'},fcm_options:{link:`https://forexverse.site${path}`}},
        android:{priority:'HIGH',notification:{channel_id:channel,sound:channel==='trade-alerts-v4'?'alert':'default'}}}}),
    });
  } catch { throw new DeliveryError('FCM_NETWORK'); }
  if (response.ok) return;
  const json = await response.json().catch(() => ({}));
  const status = typeof json?.error?.status === 'string' && /^[A-Z_]{1,64}$/.test(json.error.status) ? json.error.status : `FCM_HTTP_${response.status}`;
  const invalid = status === 'UNREGISTERED' || json?.error?.details?.some(x=>x.errorCode==='UNREGISTERED');
  if (invalid) throw new DeliveryError('UNREGISTERED', false);
  if (response.status === 401 || response.status === 403) throw new DeliveryError('FCM_AUTH_REJECTED', false);
  throw new DeliveryError(status, response.status===429 || response.status>=500 || status==='UNAVAILABLE' || status==='INTERNAL');
}

async function record(env, job, status, reason) {
  const retry = Math.min(600000,30000 * 2 ** Math.min(job.attempts,5));
  const saved = await rpc(env,'record_push_delivery_outcome',{
    p_job_id:job.id,p_attempts:job.attempts,p_status:status,p_reason_code:reason,
    p_next_attempt_at:new Date(Date.now()+retry).toISOString(),
  });
  if (!saved) console.warn('PUSH_LEASE_CHANGED',job.id);
  return saved;
}

async function revoke(env, detail, job) {
  await patch(env,'push_devices',`user_id=eq.${encodeURIComponent(detail.user_id)}&token=eq.${encodeURIComponent(job.push_token)}&revoked_at=is.null`,{revoked_at:new Date().toISOString(),invalid_at:new Date().toISOString()});
  await patch(env,'users',`id=eq.${encodeURIComponent(detail.user_id)}&push_token=eq.${encodeURIComponent(job.push_token)}`,{push_token:null});
}

// The webhook and the scheduled handler share this exact same path.
export async function drain(env) {
  const { service, project } = settings(env); // validate before claiming anything
  const accessToken = await googleToken(service); // avoid burning attempts on broken Firebase configuration
  const jobs = await rpc(env,'claim_pending_push_jobs',{p_limit:BATCH_SIZE});
  if (!Array.isArray(jobs)||!jobs.length) return {claimed:0,sent:0,failed:0,retryable:0};
  const details = await rows(env,'push_delivery_jobs',`select=id,user_id,action_url,channel_id&id=in.(${jobs.map(j=>j.id).join(',')})`)
    .catch(e=>{console.error('DETAILS_READ_FAILED',e.code);return [];});
  const indexed = new Map(details.map(x=>[x.id,x]));
  const counts = {claimed:jobs.length,sent:0,failed:0,retryable:0};
  for(let i=0;i<jobs.length;i+=PARALLELISM) {
    await Promise.all(jobs.slice(i,i+PARALLELISM).map(async job=>{
      let error = null;
      const detail = indexed.get(job.id);
      if(!detail) error = new DeliveryError('JOB_DETAILS_MISSING');
      else {
        try {
          const owners = await rows(env,'push_devices',`select=id&user_id=eq.${encodeURIComponent(detail.user_id)}&token=eq.${encodeURIComponent(job.push_token)}&revoked_at=is.null&limit=1`);
          if(!owners.length) throw new DeliveryError('OWNER_MISMATCH',false);
          await deliver(env,project,accessToken,job,detail);
        } catch(e) {error=e instanceof DeliveryError?e:new DeliveryError('SEND_EXCEPTION');}
      }
      let status = error ? (error.retryable && job.attempts < MAX_ATTEMPTS?'pending':'failed') : 'sent';
      if(error?.code==='UNREGISTERED' && detail) {
        try {await revoke(env,detail,job);}catch(e){console.error('TOKEN_REVOKE_FAILED',job.id,e.code??'UNKNOWN');}
      }
      try {
        if(await record(env,job,status,error?.code??null)) counts[status==='pending'?'retryable':status]++;
      }catch(e){ console.error('OUTCOME_RECORD_FAILED',job.id,e.code??'UNKNOWN'); }
    }));
  }
  console.log('PUSH_DRAIN',JSON.stringify(counts));
  return counts;
}

function matchesSecret(actual, expected) {
  if(!actual || !expected || actual.length!==expected.length) return false;
  let mismatch=0;
  for(let i=0;i<actual.length;i++) mismatch |= actual.charCodeAt(i)^expected.charCodeAt(i);
  return mismatch===0;
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/health' && request.method==='GET')return Response.json({ok:true,service:'forex-push-worker'});
    if(url.pathname!=='/wake')return new Response('Not found',{status:404});
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    if(!matchesSecret(request.headers.get('x-webhook-secret'),env.PUSH_WEBHOOK_SECRET))return new Response('Unauthorized',{status:401});
    // Do not trust the webhook body: drain only jobs claimed from Supabase.
    try {return Response.json({ok:true,...await drain(env)});}
    catch(e){console.error('PUSH_WAKE_FAILED',e.code??'UNKNOWN');return Response.json({ok:false,error:e.code??'DRAIN_FAILED'},{status:503});}
  },
  async scheduled(_controller,env,_ctx){
    try {await drain(env);} catch(e){console.error('PUSH_CRON_FAILED',e.code??'UNKNOWN');throw e;}
  },
};
