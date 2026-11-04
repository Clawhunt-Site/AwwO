/**
 * The Blender workstation (deploy/saas/blender/README.md): a workspace container that also runs Blender 5.2.3 as the
 * Blender Lab MCP add-on's background bridge, and the official MCP server, whose tools a run's agent calls. The worker
 * reaches that server only through deploy/saas/blender/mcp_call.py, one `docker exec -i` per call, as it reaches the
 * workspace's files through its file helper; what comes back is checked here and cut to size before a model reads it.
 */

/** The MCP server's tools an agent is offered: those that work with Blender in the background. Screenshots and
 *  jumps need a window; the *_for_cli tools start a second Blender per call, where the live one serves the same. */
export const BLENDER_TOOL_NAMES = [
  'execute_blender_code', 'get_objects_summary', 'get_object_detail_summary', 'get_blendfile_summary_datablocks',
  'get_blendfile_summary_missing_files', 'get_blendfile_summary_of_linked_libraries', 'get_blendfile_summary_path_info',
  'get_blendfile_summary_usage_guess', 'render_thumbnail_to_path', 'render_viewport_to_path', 'get_python_api_docs',
  'search_api_docs', 'search_manual_docs',
] as const;
export type BlenderToolName = typeof BLENDER_TOOL_NAMES[number];
/** One tool as the model is given it: the server's own name, description and argument schema. */
export interface BlenderTool { name: BlenderToolName; description: string; inputSchema: BlenderSchema }
export interface BlenderSchema { type: 'object'; properties: Record<string, { type: BlenderValueType; description?: string }>; required: string[] }
type BlenderValueType = 'string' | 'integer' | 'number' | 'boolean';
/** What a run's agent is told and offered (WorkspaceAbilities.blender). */
export interface BlenderAbilities { tools: BlenderTool[]; instructions: string; gpu: BlenderGpu; callSeconds: number }
export interface BlenderGpu { cycles: string; eevee: 'gpu' | 'software' }
export interface BlenderCallResult { text: string; isError: boolean; restarted: boolean }
/** How the workstation's container differs from a workspace's (AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER and its options). */
export interface WorkspaceBlender {
  /** docker run --gpus: 'all' or 'device=<n>[,<n>…]'; absent, Cycles renders on the CPU. */
  gpus?: string;
  /** The container's CPUs (--cpus). */
  cpus: number;
  /** One Blender tool call's limit in seconds; mcp_call.py stops Blender past it. */
  callSeconds: number;
}

/** The container's memory in MiB when the worker names none, and the bounds of what it may name (swap included). */
export const BLENDER_MEMORY_MB = { default: 8192, min: 2048, max: 32768 } as const;
/** /workspace and /tmp: scenes, textures, renders and Blender's own temporary files need more than a workspace's. */
export const BLENDER_TMPFS_BYTES = { workspace: 1 << 30, tmp: 1 << 30 } as const;
/** What a workstation's snapshot leaves out instead of failing on it (the file helper's snapshotLeaveOut): the
 *  top-level out/ folder and the NVIDIA driver's cache (.nv, made by a GPU program a command runs), .blend files,
 *  binaries, links, special files and every file over 256 KiB. Renders, exports and scenes are delivered by
 *  publishing, and the scene is rebuilt from its script on the node's next run. */
export const BLENDER_SNAPSHOT_LEAVE_OUT = Object.freeze({ dirs: ['out', '.nv'], fileLimit: 256 * 1024 });
/** The image's MCP client (deploy/saas/blender/mcp_call.py), and what one answer of it may hold. */
export const BLENDER_MCP_CALL = '/opt/awwo/blender/mcp_call.py';
export const BLENDER_MCP_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Waits, in the container, until Blender's bridge accepts a connection (up to a minute). */
export const BLENDER_BRIDGE_WAIT = "import socket,time\nfor _ in range(240):\n    try:\n        socket.create_connection(('127.0.0.1', 9876), 1).close(); break\n    except OSError: time.sleep(0.25)\nelse: raise SystemExit(1)";
/** What Blender's bridge carries in its environment (supervisor.py), so that a command's clean-up spares it. */
export const BLENDER_KEEP_ALIVE = 'blender-bridge';
/** What a model reads of one tool answer, at most. */
export const BLENDER_RESULT_CHARS = 64 * 1024;
const MAX_DESCRIPTION = 4096, MAX_PROPERTIES = 16, MAX_INSTRUCTIONS = 16 * 1024;
const VALUE_TYPES = new Set<BlenderValueType>(['string', 'integer', 'number', 'boolean']);
const PROPERTY = /^[a-z][a-z0-9_]{0,63}$/;
const GPUS = /^(?:all|device=\d{1,2}(?:,\d{1,2}){0,7})$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER=on and its options; anything else leaves the workstation off. */
export function loadWorkspaceBlender(env: Record<string, string | undefined>): WorkspaceBlender | undefined {
  const switched = env.AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER || 'off';
  if (switched === 'off') return undefined;
  if (switched !== 'on') throw new Error('AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER must be on or off');
  const gpus = env.AWWO_OPENAI_AGENTS_WORKSPACE_GPUS || undefined;
  if (gpus !== undefined && !GPUS.test(gpus)) throw new Error('AWWO_OPENAI_AGENTS_WORKSPACE_GPUS must be all or device=<n>[,<n>...]');
  const cpus = Number(env.AWWO_OPENAI_AGENTS_WORKSPACE_CPUS || 8);
  if (!Number.isSafeInteger(cpus) || cpus < 1 || cpus > 32) throw new Error('AWWO_OPENAI_AGENTS_WORKSPACE_CPUS must be 1-32');
  const callSeconds = Number(env.AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER_CALL_SECONDS || 280);
  if (!Number.isSafeInteger(callSeconds) || callSeconds < 10 || callSeconds > 290) throw new Error('AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER_CALL_SECONDS must be 10-290');
  return Object.freeze({ ...(gpus ? { gpus } : {}), cpus, callSeconds });
}

/** The docker run options a workstation adds to a workspace's (workspaceDockerArgs). */
export function blenderDockerOptions(blender: WorkspaceBlender): string[] {
  if (blender.gpus !== undefined && !GPUS.test(blender.gpus)) throw new Error('Invalid workspace GPUs');
  if (!Number.isSafeInteger(blender.cpus) || blender.cpus < 1 || blender.cpus > 32) throw new Error('Invalid workspace CPUs');
  // docker reads --gpus as CSV, so a device list is one quoted field (its docs: --gpus '"device=0,2"'); no shell is used.
  const gpus = blender.gpus?.includes(',') ? `"${blender.gpus}"` : blender.gpus;
  return gpus ? ['--gpus', gpus, '--env', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics'] : [];
}

/** The tool list mcp_call.py read from the server, reduced to the offered tools with schemas a model can be given:
 *  flat objects of strings, numbers and booleans. A tool whose schema is anything else is left out, never loosened. */
export function blenderTools(value: unknown): { tools: BlenderTool[]; instructions: string } {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.tools) || value.tools.length > 64) throw new Error('Invalid Blender tool list');
  const tools: BlenderTool[] = [];
  for (const item of value.tools) {
    if (!isRecord(item) || typeof item.name !== 'string' || !(BLENDER_TOOL_NAMES as readonly string[]).includes(item.name)
      || tools.some(tool => tool.name === item.name) || typeof item.description !== 'string') continue;
    const schema = toolSchema(item.inputSchema);
    if (schema) tools.push({ name: item.name as BlenderToolName, description: item.description.trim().slice(0, MAX_DESCRIPTION), inputSchema: schema });
  }
  if (!tools.some(tool => tool.name === 'execute_blender_code')) throw new Error('The Blender MCP server offers no execute_blender_code');
  const instructions = typeof value.instructions === 'string' ? value.instructions.slice(0, MAX_INSTRUCTIONS) : '';
  return { tools: tools.sort((a, b) => BLENDER_TOOL_NAMES.indexOf(a.name) - BLENDER_TOOL_NAMES.indexOf(b.name)), instructions };
}

function toolSchema(value: unknown): BlenderSchema | undefined {
  if (!isRecord(value) || value.type !== 'object') return undefined;
  const properties = value.properties ?? {};
  if (!isRecord(properties) || Object.keys(properties).length > MAX_PROPERTIES) return undefined;
  const result: BlenderSchema = { type: 'object', properties: {}, required: [] };
  for (const [key, property] of Object.entries(properties)) {
    if (!PROPERTY.test(key) || !isRecord(property)) return undefined;
    const type = valueType(property);
    if (!type) return undefined;
    result.properties[key] = { type, ...(typeof property.description === 'string' ? { description: property.description.slice(0, 1024) } : {}) };
  }
  const required = value.required ?? [];
  if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !(key in result.properties))) return undefined;
  result.required = [...new Set(required as string[])];
  return result;
}

/** A property's type: a plain one, or an optional one as pydantic writes it (anyOf the type and null, default null),
 *  which a model may leave out. Enums, arrays and objects are not taken. */
function valueType(property: Record<string, unknown>): BlenderValueType | undefined {
  if (VALUE_TYPES.has(property.type as BlenderValueType)) return property.type as BlenderValueType;
  const options = property.anyOf;
  if (!Array.isArray(options) || options.length !== 2 || property.default !== null) return undefined;
  const types = options.map(option => (isRecord(option) ? option.type : undefined));
  const plain = types.find(type => type !== 'null');
  return types.includes('null') && VALUE_TYPES.has(plain as BlenderValueType) ? plain as BlenderValueType : undefined;
}

/** Arguments a model gave a Blender tool, checked against the schema it was given; undefined when they do not fit. */
export function blenderArguments(tool: BlenderTool, value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    const property = tool.inputSchema.properties[key];
    if (!property) return undefined;
    const fits = property.type === 'string' ? typeof item === 'string'
      : property.type === 'boolean' ? typeof item === 'boolean'
        : typeof item === 'number' && Number.isFinite(item) && (property.type === 'number' || Number.isSafeInteger(item));
    if (!fits) return undefined;
    result[key] = item as string | number | boolean;
  }
  return tool.inputSchema.required.every(key => key in result) ? result : undefined;
}

/** A call's answer from mcp_call.py, as the model reads it: the server's text parts, cut to BLENDER_RESULT_CHARS. A
 *  failed call says why in closed words, and that Blender started again when it did. */
/** How the task process gives the model an answer Blender called an error (workspace-runtime.ts). */
export const BLENDER_ERROR_PREFIX = 'Blender reported an error:\n';
/** What an answer says first when the scene was lost: Blender stopped during the call (the code exited or crashed it,
 *  or the call outlived its time), or had stopped since the last Blender call (a crash that call could not see yet, a
 *  command that stopped it), and another Blender runs now, with an empty scene. */
export const BLENDER_SCENE_LOST = {
  during: '[Blender stopped during this call and was started again with an empty scene: rebuild it from your script before going on.]',
  before: '[Blender had stopped since your last Blender call and was started again with an empty scene, in which this call ran: rebuild it from your script before going on.]',
} as const;
/** Which Blender answered (mcp_call.py: its pid and start time), so that a call can tell another one from it. */
const BRIDGE = /^\d{1,10}:\d{1,20}$/;
export const blenderBridge = (value: unknown, key: 'before' | 'after'): string | null =>
  isRecord(value) && typeof value[key] === 'string' && BRIDGE.test(value[key]) ? value[key] : null;

/** One mcp_call.py answer as the model reads it. lost: the call found another Blender than the one that gave the last
 *  answer (the sandbox keeps track, outside the container). The scene's loss is said first, so that a shortened copy
 *  of the answer (workspace-context.ts) still says it. */
export function blenderCallResult(value: unknown, lost = false): BlenderCallResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('Invalid Blender call result');
  const during = value.restarted === true;
  const note = during ? BLENDER_SCENE_LOST.during : lost ? BLENDER_SCENE_LOST.before : '';
  const noted = (text: string) => (note ? `${note}\n${text}` : text);
  if (!value.ok) {
    const text = value.error === 'timeout'
      ? 'The Blender call ran out of time. Split long work (a heavy render, a large loop) into shorter calls.'
      : 'The Blender MCP server could not answer this call. Check the arguments, then try again; if it fails again, rebuild the scene from your script.';
    return { isError: true, restarted: during || lost, text: noted(text) };
  }
  if (!Array.isArray(value.content)) throw new Error('Invalid Blender call result');
  let text = value.content.map(part => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n');
  if (value.content.some(part => isRecord(part) && part.type !== 'text')) text += '\n[A part of this answer that was not text was left out.]';
  if (text.length > BLENDER_RESULT_CHARS) text = `${text.slice(0, BLENDER_RESULT_CHARS)}\n[… cut: the answer was ${text.length} characters; return less from your code.]`;
  return { text: noted(text), isError: value.isError === true || during || lost, restarted: during || lost };
}

/** What the worker learned of the container's GPU (startup.py's /tmp/awwo-gpu.json), in the words the agent is told:
 *  Cycles' device ('none' without one) and whether EEVEE draws on the GPU or in software. */
export function blenderGpu(value: unknown): BlenderGpu {
  const eevee = isRecord(value) && value.eevee === 'gpu' ? 'gpu' : 'software';
  if (!isRecord(value) || value.device !== 'GPU' || !Array.isArray(value.names) || !value.names.length) return { cycles: 'none', eevee };
  const backend = value.backend === 'OPTIX' || value.backend === 'CUDA' ? value.backend : 'GPU';
  const names = value.names.filter((name): name is string => typeof name === 'string' && /^[\w .()+-]{1,64}$/.test(name)).slice(0, 4);
  return { cycles: `${backend}: ${names.join(', ') || 'GPU'}`, eevee };
}

/** The agent's instructions for the workstation: the MCP server's own, then AwwO's. */
export function blenderInstructions(abilities: BlenderAbilities): string {
  const { callSeconds } = abilities;
  const cycles = abilities.gpu.cycles === 'none'
    ? 'This workstation has no GPU: Cycles renders on the CPU, so keep renders small (about 960x540, 32-64 samples with denoising).'
    : `Cycles renders on the GPU (${abilities.gpu.cycles}); its preferences are set: use scene.render.engine = 'CYCLES' and scene.cycles.device = 'GPU', 64-256 samples with denoising.`;
  const eevee = abilities.gpu.eevee === 'gpu' ? 'EEVEE (BLENDER_EEVEE) draws on the GPU too, for fast stylised renders.'
    : 'EEVEE (BLENDER_EEVEE) draws in software here, many times slower than Cycles on the GPU: render with Cycles.';
  const gpu = `${cycles} ${eevee}`;
  return [
    'Blender workstation: a live Blender 5.2.3 runs in this workspace (in the background, without a window), and the Blender Lab MCP server\'s tools reach it. Its scene starts empty and lasts the whole run.',
    `Each tool call has ${callSeconds} s. A call that runs longer, or code that crashes Blender, starts Blender again with an empty scene, and the tool says so: keep the scene as a script. Write it to a workspace file (scene.py) with workspace_write, run it with execute_blender_code (exec(open('/workspace/scene.py').read())), and change the file rather than the live scene alone, so that the node's next run can rebuild it. Return what you need to read from the code in its result dict (counts, bounding boxes, file sizes), never whole meshes.`,
    'Blender\'s working directory is /workspace, which is also the project workspace: write every output under /workspace/out/ and publish each file a field needs with workspace_publish. out/, .blend files, binary files and files over 256 KiB are not kept for the node\'s next run; publish what the node delivers.',
    'This Blender has no screen: an operator that fails for want of a window or an active object (bpy.ops.export_scene.gltf among them) runs inside `with bpy.context.temp_override(window=bpy.context.window_manager.windows[0]):`, with the objects it needs selected and one of them active; prefer bpy.data over bpy.ops for building.',
    gpu,
    'For a page: export binary glTF with bpy.ops.export_scene.gltf(filepath=..., export_format=\'GLB\', export_apply=True), modifiers applied, textures as JPEG (export_image_format=\'JPEG\'), no Draco (the page preview has no decoder), each file at most 2 MiB (decimate or bake when it is larger); renders as PNG or JPEG under 2 MiB. Node-built (procedural) materials do not survive glTF export: for the GLB, bake them to image textures (Cycles bake, at most 1024 px, JPEG) or give its materials plain colour and roughness values; the render keeps the full shaders. Name the camera and lights you made, frame the subject, and check before you publish: a quick render_thumbnail_to_path, the object count, dimensions and the file sizes your code reads back.',
    '`import awwo_param` in execute_blender_code gives tested parametric generators (minimal surfaces, Voronoi skins, attractor panels, ice-crack tiling, phyllotaxis and spirals, reciprocal frames, slime-mould networks): `help(awwo_param)` lists them, and `from awwo_param import blender` makes Blender objects of what they return. Use them rather than writing such geometry anew.',
    'The workspace has no network, so Blender cannot download add-ons, textures or HDRIs: build materials from nodes (procedural textures) and light the scene yourself.',
    abilities.instructions ? `The Blender MCP server's own guidance:\n${abilities.instructions}` : '',
  ].filter(Boolean).join('\n');
}
