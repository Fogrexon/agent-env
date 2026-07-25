/**
 * Offline smoke: AgentParams YAML load + apply for every discovered agent.
 */
import {
  applyAgentParams,
  defaultValuesFromParams,
  loadAgentParamsFile,
} from '@agent-env/harness';
import { listAgents } from './agent-catalog.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const agents = listAgents();
assert(agents.length > 0, 'no agents discovered under agents/*/');

for (const manifest of agents) {
  assert(manifest.paramsFile, `${manifest.id}: paramsFile required`);
  const spec = loadAgentParamsFile(manifest.paramsFile);
  assert(spec.agentId === manifest.id, `${manifest.id}: agentId mismatch`);
  const defaults = defaultValuesFromParams(spec);
  const applied = applyAgentParams(spec, defaults, { checkFiles: false });
  assert(applied.objective.length > 0, `${manifest.id}: empty objective`);

  // Empty optional fields must still appear in inputs so ADK `{fieldId}`
  // instruction injection does not throw.
  const blanked = { ...defaults };
  for (const field of spec.fields) {
    if (field.required) continue;
    if (field.type === 'files' || field.type === 'images') blanked[field.id] = [];
    else if (field.type === 'boolean') blanked[field.id] = false;
    else if (field.type === 'number' && field.default === undefined) {
      blanked[field.id] = '';
    } else if (field.default === undefined) {
      blanked[field.id] = '';
    }
  }
  const appliedBlank = applyAgentParams(spec, blanked, { checkFiles: false });
  for (const field of spec.fields) {
    if (field.required) continue;
    assert(
      field.id in appliedBlank.inputs,
      `${manifest.id}: optional "${field.id}" missing from inputs when empty`,
    );
  }

  console.log(
    `✓ ${manifest.id}  fields=${spec.fields.length}  objectiveField=${spec.objectiveField}`,
  );
}

console.log('✓ smoke-params passed');
