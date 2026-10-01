import { CREATIVE_CASES } from './creativeCatalog';
import { INTELLIGENCE_CASES } from './intelligenceCatalog';
import { OPERATIONS_CASES } from './operationsCatalog';
import { industryWorkflow } from './industryWorkflow';

export const INDUSTRY_CASES = CREATIVE_CASES.flatMap((item, index) => [item, OPERATIONS_CASES[index], INTELLIGENCE_CASES[index]]);
export const INDUSTRY_WORKFLOWS = INDUSTRY_CASES.map(industryWorkflow);
export const CREATIVE_CASE_IDS = new Set(CREATIVE_CASES.map(item => item.id));
export const INTELLIGENCE_CASE_IDS = new Set(INTELLIGENCE_CASES.map(item => item.id));
export const OPERATIONS_CASE_IDS = new Set(OPERATIONS_CASES.map(item => item.id));
