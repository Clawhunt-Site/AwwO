import type { OfficialWorkflowNode } from './examples/officialWorkflows';

/** What every flagship builder is told (flagshipWorkflows.ts, flagshipErrand.ts): its module's duties, the fixed kernel
 * contract, and the rules that make modules written apart by different agents fit into one page. */
export interface FlagshipApp {
  readonly app: string; readonly global: string; readonly noun: string; readonly kernel: string; readonly column: number;
  /** How many other modules the builders beside this one write (default eight). */
  readonly others?: string;
}
export const moduleRules = (product: FlagshipApp, name: string, limit: number) => `Rules for every module:
- Write the ${name} module as the kernel contract says: ${name === 'core' ? `it alone creates window.${product.global}, with every name the contract gives core, as its script runs (it is the first script of the page)` : `one IIFE that attaches its part of the contract to U as the script runs, registers its init with U.module('${name}', init) and defines no global`}. Use other modules only through kernel names; never redefine, patch or wrap them. Something the contract does not provide stays private to your module.
- Register every user action as a command, every tool with U.tools.register, every panel with U.panels.register, as the spec assigns them to you. Register your acceptance tests with U.tests.add and your planted failures with U.tests.plant, by the spec's numbers; a test checks real behaviour with real values, never only that nothing threw.
- The page runs in a sandboxed frame: no network, storage, cookies, workers, external scripts, imports or downloads; fonts only by name from those AwwO supplies (Inter, Space Grotesk, JetBrains Mono, Playfair Display, Instrument Serif, Bebas Neue, Manrope, Montserrat), each followed by a generic fallback, never linked; canvas text is drawn after document.fonts.ready. Everything runs on the main thread: slice any work longer than 50 ms with requestAnimationFrame or setTimeout so the ${product.noun} never freezes. Interface text is English.
- Compact code: no comments, no blank lines, short local names, tables and loops instead of repetition; at most ${limit.toLocaleString('en-US')} characters in all; when space runs short, drop polish before you drop a contract name or a test.
- You work in the sandbox computer, and your answer is a file, not a message: write the module as numbered parts p01.js, p02.js, … of at most 6,000 characters each with workspace_write (one part a step), join them with cat p*.js > ${name}.js, run node --check ${name}.js and fix what it reports, then publish ${name}.js into your result output: call workspace_publish with field "result" and path "${name}.js", and end with exactly this reply and nothing else: {"result": ""} (the host fills in the published file). Ignore any rule about answering with one code block: the assemble node pastes the published file into the page byte for byte.
- This run ends after 25 minutes and about 60 model calls: write the parts first, check once, publish; keep what each command prints short.`;

export const builderFor = (product: FlagshipApp & { readonly modules: string }) => (id: string, title: string, row: number, duties: string, limit: number): OfficialWorkflowNode => ({
  id, title, role: 'frontend', column: product.column, row, output: `${title} code`, sandbox: true,
  task: `Build the ${id} module of ${product.app} from the spec in your inputs and the kernel contract below; the other ${product.others ?? 'eight'} modules are written at the same time by other builders who share only the spec and the contract. Where the spec and this task disagree, this task and the kernel contract win.\n${duties}\n\n${product.kernel}\n\n${moduleRules(product, id, limit)}`,
  acceptance: [`Runs as pasted; defines and registers exactly what the contract and the spec give the ${id} module`, 'Registers its acceptance tests and planted failures by the spec\'s numbers'],
});
