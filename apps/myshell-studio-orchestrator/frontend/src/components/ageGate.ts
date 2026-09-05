export function shouldBypassAgeGateForDev(search: string, isDev = import.meta.env.DEV): boolean {
  if (!isDev) return false;
  const params = new URLSearchParams(search || '');
  return params.has('test_route') || params.get('age_gate') === 'passed';
}
