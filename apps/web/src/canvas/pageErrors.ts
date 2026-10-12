// A delivered page that fails when it runs says so. AwwO's own script, ahead of everything the page brings, hands the
// first uncaught error to the preview that shows the page; the page runs in an opaque-origin sandbox, so a message to
// the host is its only way out, and the host checks event.source before believing one. The preview passes it on here,
// with the page's lines where it happened, and the canvas decides what to do with it (pageRepair.ts).
//
// An explainer figure can also fail with no error at all: it draws once and then never moves. The same script watches
// a figure the kit has mounted and reports that too, as kind 'still', with what it saw.

export const PAGE_ERROR_MESSAGE = 'awwo-page-error';

/** How long a figure must stay unchanged on screen before AwwO tries it, and how long each hover or key may take. */
export const STILL_IDLE_MS = 4000;
export const STILL_STEP_MS = 500;

/**
 * The figure watch, inside the reporter's scope (it uses `send`, `sent` and `frames`). `sig` is the drawing as it looks:
 * the svg's elements, attributes and text, and the attributes of the elements around it up to the page's `main`, but not
 * what draws nothing (aria-*, role, tabindex) and not an attribute named like a property (`setAttribute("innerHTML", …)`
 * makes one), which it notes instead. The readout is outside it: a readout that changes while no part moves is still.
 */
const stillWatch = (idleMs: number, stepMs: number) => ''
  + "const watch=svg=>{const root=svg.closest('main')||document.body;if(root.querySelector('canvas'))return;"
  + "const SKIP=/^(?:aria-|role$|tabindex$)/i,BAD=/^(?:innerhtml|outerhtml|textcontent|innertext)$/i;let bad=null;"
  + "const sig=()=>{let s='';const b={n:0},w=document.createTreeWalker(svg,5);for(let n=w.currentNode;n;n=w.nextNode()){"
  + "if(n.nodeType===3){s+=n.data;continue}s+='<'+n.localName;for(const a of n.attributes){"
  + "if(BAD.test(a.name)){if(!b.n++){b.name=a.name;b.tag=n.localName;b.part=n.getAttribute('data-part')}}"
  + "else if(!SKIP.test(a.name))s+=' '+a.name+'=\"'+a.value+'\"'}}"
  + "for(let e=svg.parentElement;e&&e!==root.parentElement;e=e.parentElement){s+='|'+e.localName;"
  + "for(const a of e.attributes)if(!SKIP.test(a.name))s+=' '+a.name+'=\"'+a.value+'\"'}bad=b.n?b:null;return s};"
  + "const text=()=>{const t=root.querySelector('[data-readout]');return t?t.textContent.trim():''};"
  + "let shown=1,io=null;try{io=new IntersectionObserver(e=>{shown=e[e.length-1].isIntersecting});io.observe(svg);shown=0}catch(e){}"
  + "const stage=svg.closest('.iso-stage')||svg;"
  + "const fire=(t,type,C,o)=>{try{const E=window[C]||MouseEvent;"
  + "t.dispatchEvent(new E(type,Object.assign({bubbles:true,cancelable:true,composed:true,view:window},o)))}catch(e){}};"
  + "const hover=f=>{const b=svg.getBoundingClientRect();if(!b.width||!b.height)return;const x=b.left+b.width*f,y=b.top+b.height*.6;"
  + "let t=null;try{t=document.elementFromPoint(x,y)}catch(e){}if(!t||!root.contains(t))t=svg;"
  + "const o={clientX:x,clientY:y,pointerId:1,pointerType:'mouse',isPrimary:true},in_=Object.assign({bubbles:false},o);"
  + "fire(stage,'pointerenter','PointerEvent',in_);fire(stage,'mouseenter','MouseEvent',in_);"
  + "for(const [type,C] of [['pointerover','PointerEvent'],['mouseover','MouseEvent'],['pointermove','PointerEvent'],['mousemove','MouseEvent']])fire(t,type,C,o)};"
  + "const press=(key,code,n)=>{for(const type of ['keydown','keyup'])try{"
  + "const e=new KeyboardEvent(type,{key,code,bubbles:true,cancelable:true,composed:true});"
  + "Object.defineProperty(e,'keyCode',{get:()=>n});Object.defineProperty(e,'which',{get:()=>n});svg.dispatchEvent(e)}catch(e){}};"
  + "const steps=[()=>hover(.3),()=>hover(.72),()=>press('ArrowRight','ArrowRight',39),()=>press('ArrowLeft','ArrowLeft',37),"
  + "()=>press(' ','Space',32),()=>press('Enter','Enter',13),()=>press('End','End',35),()=>press('Home','Home',36)];"
  + `let last=null,read0='',f0=0,seen=0,next=${idleMs},step=0,timer=0;const t0=Date.now();`
  + "const stop=()=>{clearInterval(timer);if(io)io.disconnect()};"
  + "timer=setInterval(()=>{try{if(sent||!svg.isConnected||Date.now()-t0>600000)return stop();"
  + "if(!shown||document.visibilityState==='hidden')return;const now=sig();"
  + "if(last===null){last=now;read0=text();f0=frames;return}if(now!==last)return stop();"
  + `seen+=${stepMs};if(seen<next)return;if(step<steps.length){steps[step++]();next=seen+${stepMs};return}stop();`
  + "const r=text(),nf=frames-f0,notes=[];"
  + "if(bad)notes.push('The page sets an attribute named \"'+bad.name+'\" on <'+bad.tag+(bad.part?' data-part=\"'+bad.part+'\"':'')+'>'"
  + "+(bad.n>1?' and on '+(bad.n-1)+' more element'+(bad.n>2?'s':''):'')+': setAttribute(\"'+bad.name+'\", …) draws nothing. "
  + "Assign the property instead: el.'+(/text/i.test(bad.name)?'textContent':'innerHTML')+' = ….');"
  + "notes.push(nf>30?'The animation loop kept running ('+nf+' frames during the test), yet nothing in the drawing changed: "
  + "its tick must call draw(), and draw() must set the moving parts\\' transform or d, or refill their data-part group.'"
  + ":'Almost no animation frame ran during the test ('+nf+'): if the figure moves through k.loop, call the kick() it returns "
  + "after each input, and let its tick return true while anything still moves.');"
  + `send('The drawing never moved: in ${idleMs / 1000} s on screen nothing in it changed by itself, and hovering across it and `
  + "pressing →, ←, Space, Enter, End and Home moved nothing either. '+(r!==read0?'Only the readout changed, from \"'+read0+'\" to \"'+r+'\".'"
  + ":'The readout stayed \"'+read0+'\".'),0,0,'','still',notes)"
  + `}catch(e){stop()}},${stepMs})};`;

/**
 * Runs first in a running preview (with PREVIEW_VIEWPORT_SCRIPT, htmlDeliverable.ts). Reports the first uncaught script
 * error or unhandled rejection, once. What is not the page's own mistake is left alone: a cross-origin "Script error."
 * with no detail, the browser's ResizeObserver loop notice, a request the preview blocks, a missing WebGL context.
 *
 * A figure page's own script runs inside AwwO's figure kit (`Anatomy.run`), which catches its error, logs the Error with
 * console.error and shows its `.anatomy-error` card instead of throwing, so no error event follows. The first such card
 * is reported too, with the Error the kit logged just before it (its stack carries the page's lines). The first
 * production figure, 2026-10-12, stopped exactly so: `Cannot access … before initialization`, and nothing was repaired.
 *
 * A figure the kit mounted (`main.iso-page` with its svg, `window.Anatomy` defined) that never errs is watched while it
 * is on screen: `idleMs` for anything in its drawing to change by itself (the idle tour the guide asks for), then a hover
 * at two points and the keys the guide names (→ ← Space Enter End Home), `stepMs` each, dispatched to the drawing. The
 * first change ends the watch for good. A figure that never changed is reported as 'still', with what AwwO saw: an
 * attribute named like a property, and whether its animation loop ran (this script counts requestAnimationFrame calls).
 * A figure is not judged while it is hidden or off screen (the kit pauses its loop then), nor one drawn on a canvas.
 * The same first production figure, once repaired, was such a page: its loop never called draw(), and draw() wrote
 * `setAttribute("innerHTML", …)`.
 */
export function pageErrorScript(idleMs = STILL_IDLE_MS, stepMs = STILL_STEP_MS): string {
  return "(()=>{let sent=0,caught=null,frames=0,watching=0;"
    + "const noise=/^(?:Uncaught )?Script error\\.?$|ResizeObserver loop|Failed to fetch|NetworkError|Load failed|Content Security Policy|WebGL context/i;"
    + "const send=(m,l,c,s,k,n)=>{m=String(m||'').slice(0,600);if(sent||!m.trim()||noise.test(m))return;sent=1;"
    + `const d={type:'${PAGE_ERROR_MESSAGE}',message:m,line:+l||0,column:+c||0,stack:String(s||'').slice(0,1500)};if(k){d.kind=k;d.notes=n}`
    + "try{parent.postMessage(d,'*')}catch(e){}};"
    + "addEventListener('error',e=>{if(e instanceof ErrorEvent)send(e.message||(e.error&&e.error.message),e.lineno,e.colno,e.error&&e.error.stack)},true);"
    + "addEventListener('unhandledrejection',e=>{const r=e.reason;"
    + "send('Unhandled promise rejection: '+(r&&r.message?(r.name||'Error')+': '+r.message:String(r)),0,0,r&&r.stack)});"
    + "try{const log=console.error;console.error=function(){for(const x of arguments)if(x instanceof Error){caught=x;break}return log.apply(this,arguments)}}catch(e){}"
    + "try{const raf=requestAnimationFrame;requestAnimationFrame=function(f){frames++;return raf.call(window,f)}}catch(e){}"
    + stillWatch(idleMs, stepMs)
    + "try{new MutationObserver((r,o)=>{const n=document.querySelector('.anatomy-error');"
    + "if(n){o.disconnect();const x=caught;send(x?(x.name||'Error')+': '+x.message:n.textContent,0,0,x&&x.stack);return}"
    + "if(!watching&&!sent&&window.Anatomy){const f=document.querySelector('main.iso-page svg');if(f){watching=1;try{watch(f)}catch(e){}}}"
    + "}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}})();";
}

export const PAGE_ERROR_SCRIPT = pageErrorScript();

/** A page that failed to run, as the preview that showed it saw it. */
export interface PageErrorReport {
  /** The page as delivered (the text the preview was given), so the canvas can find the node that published it. */
  page: string;
  /** The browser's message, e.g. "Uncaught SyntaxError: Identifier 'tokens' has already been declared". */
  message: string;
  /** The page's own code where it happened, as the preview ran it: the reported line first, then the call stack's.
   *  For a figure that never moves, what AwwO saw while it tried the figure. */
  lines: string[];
  /** 'still': a figure that runs without an error and never moves. Absent for a page that failed. */
  kind?: 'still';
}

/** One line of the running document around a (1-based) column; a long line (a minified library) is cut around it. */
function lineAround(rows: string[], line: number, column: number): string {
  const text = rows[line - 1]?.trim() ?? '';
  if (text.length <= 240) return text;
  const start = Math.max(0, column - 1 - 120);
  return `${start ? '…' : ''}${text.slice(start, start + 240)}…`;
}

/**
 * Read a message a preview's frame posted. `document` is the exact text the frame was given (its line numbers are the
 * ones the browser reports), `page` the delivered page it was built from. Null for anything that is not a report.
 */
export function readPageErrorMessage(data: unknown, document: string, page: string): PageErrorReport | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as { type?: unknown; message?: unknown; line?: unknown; column?: unknown; stack?: unknown; kind?: unknown; notes?: unknown };
  if (value.type !== PAGE_ERROR_MESSAGE || typeof value.message !== 'string' || !value.message.trim()) return null;
  const message = value.message.trim().slice(0, 600);
  if (value.kind === 'still') {
    const notes = (Array.isArray(value.notes) ? value.notes : []).filter((note): note is string => typeof note === 'string' && Boolean(note.trim()));
    return { page, message, lines: notes.slice(0, 4).map(note => note.trim().slice(0, 400)), kind: 'still' };
  }
  const rows = document.split('\n');
  const spots: Array<[number, number]> = [[Number(value.line) || 0, Number(value.column) || 0]];
  for (const match of String(value.stack ?? '').matchAll(/about:srcdoc:(\d+):(\d+)/g)) spots.push([Number(match[1]), Number(match[2])]);
  const lines: string[] = [];
  for (const [line, column] of spots) {
    if (line < 1 || line > rows.length) continue;
    const text = lineAround(rows, line, column);
    if (text && !lines.includes(text)) lines.push(text);
    if (lines.length === 3) break;
  }
  return { page, message, lines };
}

type Listener = (report: PageErrorReport) => void;
const listeners = new Set<Listener>();

/** Hear every page that fails in a preview on this screen. Returns the unsubscribe. */
export function subscribePageErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by a preview when its page reported an error. A page nobody published (a homepage case) changes nothing. */
export function reportPageError(report: PageErrorReport): void {
  for (const listener of [...listeners]) {
    try { listener(report); } catch { /* a listener's failure is its own */ }
  }
}
