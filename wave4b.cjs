'use strict';
const https = require('node:https');
const FEATURES = [
 {
  "id": "asset-inspection-risk",
  "title": "Asset & inspection risk triage",
  "tables": [
   "assets",
   "inspections",
   "workOrders"
  ],
  "focus": "Pipe/pump/meter condition, valve/hydrant inspections, and break/leak work orders.",
  "recommendations": [
   "Prioritise high-risk assets with overdue inspections",
   "Assign break/leak work orders to field owners",
   "Re-inspect assets after repair completion"
  ]
 },
 {
  "id": "water-quality-review",
  "title": "Water quality exceedance review",
  "tables": [
   "waterQuality",
   "regulatory",
   "customerNotices"
  ],
  "focus": "Sampling results, exceedances, regulatory deadlines, and customer notice language.",
  "recommendations": [
   "Follow up exceedances with resampling first",
   "Prepare regulatory evidence for overdue reports",
   "Issue customer notices for affected zones"
  ]
 },
 {
  "id": "outage-capital-priority",
  "title": "Outage & capital priority review",
  "tables": [
   "outages",
   "capitalPlanning",
   "assets"
  ],
  "focus": "Service interruptions, boil notices/restoration, CIP risk scores and budgets.",
  "recommendations": [
   "Restore high-priority outages and confirm notices",
   "Re-rank CIP projects by asset risk score",
   "Confirm budgets for overdue capital projects"
  ]
 }
];
function todayStr(){return new Date().toISOString().slice(0,10);}
function providerConfig(env){
  if(env.OPENROUTER_API_KEY && !/changeme|your[_-]?key|placeholder/i.test(env.OPENROUTER_API_KEY)) return {name:'openrouter',key:env.OPENROUTER_API_KEY,model:env.OPENROUTER_MODEL||'openai/gpt-4o-mini',host:'openrouter.ai',path:'/api/v1/chat/completions'};
  if(env.OPENAI_API_KEY && !/changeme|your[_-]?key|placeholder/i.test(env.OPENAI_API_KEY)) return {name:'openai',key:env.OPENAI_API_KEY,model:env.OPENAI_MODEL||'gpt-4o-mini',host:'api.openai.com',path:'/v1/chat/completions'};
  return null;
}
function fallback(feature, store){
  const tables = feature.tables.filter(t=>Array.isArray(store.data[t]));
  const rows = tables.flatMap(t=>(store.data[t]||[]).map(r=>({...r,_table:t})));
  const today=todayStr();
  const blocked=rows.filter(r=>r.status==='Blocked').length;
  const overdue=rows.filter(r=>r.dueDate && r.dueDate<today && r.status!=='Complete').length;
  const high=rows.filter(r=>r.priority==='High'||r.priority==='Escalate').length;
  const complete=rows.filter(r=>r.status==='Complete').length;
  const avgRisk=rows.length?Math.round(rows.reduce((s,r)=>s+Number(r.riskScore||0),0)/rows.length):0;
  const top=[...rows].sort((a,b)=>Number(b.riskScore||0)-Number(a.riskScore||0)).slice(0,5).map(r=>({id:r.id,item:r.item,table:r._table,status:r.status,priority:r.priority,riskScore:Number(r.riskScore||0),dueDate:r.dueDate,owner:r.owner}));
  const findings=[];
  findings.push(blocked? blocked+' blocked record(s) need owner follow-up.' : 'No blocked records in scope.');
  findings.push(overdue? overdue+' overdue record(s) past due date.' : 'No overdue records in scope.');
  findings.push(high? high+' high/escalated priority record(s).' : 'No high-priority records in scope.');
  return {featureId:feature.id,title:feature.title,aiGenerated:false,provider:'deterministic-fallback',model:null,label:'Deterministic fallback — no AI provider configured (aiGenerated: false)',generatedAt:new Date().toISOString(),focus:feature.focus,summary:feature.title+': '+rows.length+' record(s) across '+tables.join(', ')+'; average risk '+avgRisk+'.',metrics:{recordsConsidered:rows.length,blockedCount:blocked,overdueCount:overdue,highPriorityCount:high,completeCount:complete,averageRisk:avgRisk,hasBlocked:blocked>0,hasOverdue:overdue>0},findings,recommendations:feature.recommendations,records:top};
}
function callProvider(cfg, feature, fb){
  const body=JSON.stringify({model:cfg.model,messages:[{role:'system',content:'Return only JSON with keys summary (string), findings (array of strings), recommendations (array of strings). Ground every claim in the supplied records; do not invent facts.'},{role:'user',content:JSON.stringify({feature:feature.title,focus:feature.focus,deterministicAnalysis:fb}).slice(0,12000)}]});
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:cfg.host,path:cfg.path,method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.key,'Content-Length':Buffer.byteLength(body)}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{try{if(res.statusCode<200||res.statusCode>=300)throw new Error('provider '+res.statusCode);const p=JSON.parse(t);const content=p.choices&&p.choices[0]&&p.choices[0].message&&p.choices[0].message.content;const parsed=JSON.parse(String(content).replace(/^```json\s*|\s*```$/g,''));resolve({...fb,...parsed,featureId:feature.id,title:feature.title,aiGenerated:true,provider:cfg.name,model:p.model||cfg.model,label:'AI-generated via '+cfg.name});}catch(e){reject(e);}});});
    req.on('error',reject); req.setTimeout(30000,()=>{req.destroy(new Error('provider timeout'));}); req.write(body); req.end();
  });
}
function createWave4B({config, env=process.env}={}){
  async function handle(req,res,pathname,{requireAuth,readBody,sendJson,store}){
    if(pathname==='/api/ai/domain' && req.method==='GET'){const s=requireAuth(req,res,'ai');if(!s)return true;sendJson(res,{features:FEATURES.map(f=>({id:f.id,title:f.title,tables:f.tables,focus:f.focus})),providerConfigured:Boolean(providerConfig(env))});return true;}
    const m=pathname.match(/^\/api\/ai\/domain\/([^/]+)$/);
    if(!m || req.method!=='POST') return false;
    const s=requireAuth(req,res,'ai');if(!s)return true;
    const feature=FEATURES.find(f=>f.id===decodeURIComponent(m[1]));
    if(!feature){sendJson(res,{error:'Unknown AI feature'},404);return true;}
    const fb=fallback(feature,store);
    const cfg=providerConfig(env);
    if(!cfg){sendJson(res,fb);return true;}
    try{ sendJson(res, await callProvider(cfg,feature,fb)); }catch(e){ sendJson(res,{...fb,providerError:'Provider call failed; showing deterministic fallback (aiGenerated: false).'}); }
    return true;
  }
  return {handle, FEATURES, fallback, providerConfig};
}
module.exports={createWave4B};
