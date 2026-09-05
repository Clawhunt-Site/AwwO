import { shouldBypassAgeGateForDev } from './ageGate';

const devTestRouteBypassContract = shouldBypassAgeGateForDev('?test_route=dreamy', true);
const devExplicitBypassContract = shouldBypassAgeGateForDev('?age_gate=passed', true);
const productionBypassContract = shouldBypassAgeGateForDev('?test_route=dreamy', false);

void devTestRouteBypassContract;
void devExplicitBypassContract;
void productionBypassContract;
