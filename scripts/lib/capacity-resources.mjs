/** CPU ceilings for synthetic background workloads; never changes deployment defaults. */
export function backgroundCpuLimits(env){
 const limits={api:Number(env.ADI_CAPACITY_API_CPUS??0.5),jobs:Number(env.ADI_CAPACITY_JOBS_CPUS??0.25)};
 for(const value of Object.values(limits))if(!Number.isFinite(value)||value<0.1||value>1)throw new Error('Background CPU quota must be 0.1..1');
 return limits;
}

/** Both streams use Docker host wall time. Once all requests are admitted in
 * one isolated burst, retained items only drain; two pending observations bound
 * a conservative interval of pending collection work. */
export function assessTokenCheckOverlap(samples,checks,totalExpected){
 const pending=samples.filter(s=>Number.isFinite(s.sampled_at_ms)&&s.delivery?.admitted===totalExpected&&s.delivery.retainedItems>0).map(s=>s.sampled_at_ms).sort((a,b)=>a-b);
 const start=pending[0],end=pending.at(-1),windows=checks?.token_check_windows??[];
 const overlap=Number.isFinite(start)&&Number.isFinite(end)&&end>start?windows.filter(w=>Number.isFinite(w.started_at_ms)&&Number.isFinite(w.finished_at_ms)&&w.finished_at_ms>w.started_at_ms&&Math.min(w.finished_at_ms,end)>Math.max(w.started_at_ms,start)).length:0;
 return {pass:overlap>0&&checks.token_check_errors===0&&checks.token_check_window_overflow===false,overlapping_checks:overlap,queue_window:pending.length?{start,end}:null,scope:'a daily-check execution overlaps the sampled fully-admitted pending queue; same Docker host wall clock, not proof of simultaneous SQL statements'};
}

/** Task completion only. Result freshness must be checked separately. */
export function assessBackgroundCatchup(rows,{checksEnabled,derivations,checks}){
 const count=(kind,status)=>rows.filter(r=>r.kind===kind&&(status===undefined||r.status===status)).reduce((n,r)=>n+r.jobs,0);
 const derived={expected:derivations,total:count('derive_session'),succeeded:count('derive_session','succeeded')},quality={enabled:checksEnabled,expected:checks,total:count('session_token_check'),succeeded:count('session_token_check','succeeded')};
 return {pass:derived.total===derivations&&derived.succeeded===derivations&&quality.total===checks&&(!checksEnabled||quality.succeeded===checks),derivations:derived,checks:quality};
}
