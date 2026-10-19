import type {SimulationBaseline} from './billing-simulation.js';
/** An explicit scenario assumption, not a learned system-prompt measurement.
 * Published person/day pages and known Hook links do not prove a complete
 * session label. Until that evidence exists, no bill is eligible for learning.
 * In particular, the evaluated window must never calibrate its own estimate.
 */
export function simulationBaseline(input:{period:{from:string;to:string};model:string|null;override:string|undefined;sourceConfigured:boolean}):SimulationBaseline{
 return {tokens:input.override??'24000',source:input.override===undefined?'default':'scenario_override',model:input.model,samples:0,version:'untrained-scenario-v2',training_before:input.period.from,calibrated:false,
  reason:input.override!==undefined?'scenario_override':!input.model?'hook_model_unknown':!input.sourceConfigured?'official_source_unavailable':'session_labels_unproven'};
}
