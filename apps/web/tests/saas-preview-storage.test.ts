// A delivered page runs in an opaque-origin sandbox, which refuses localStorage, sessionStorage and document.cookie
// with a SecurityError (PREVIEW_STORAGE_SCRIPT, htmlDeliverable.ts). On 2026-10-25 one account's login and role pages
// died at their first line there, and each refusal went back to the node for a paid repair. The stand-ins keep what a
// page stores while it is open, so it runs as it does where it is deployed.
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_HOST_SCRIPT, PREVIEW_STORAGE_SCRIPT } from '../src/canvas/htmlDeliverable';

const opened: JSDOM[] = [];
afterEach(() => { for (const dom of opened.splice(0)) dom.window.close(); });

/** A page as the sandbox runs it: jsdom refuses storage to an opaque origin as the browser does, and the cookie is
 *  made to refuse the same way (jsdom alone would give one). `url` gives the page an origin of its own instead. */
function page(url?: string) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole(), ...url ? { url } : {} });
  opened.push(dom);
  if (!url) {
    const refuse = () => { throw new dom.window.DOMException("Failed to read the 'cookie' property from 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag.", 'SecurityError'); };
    Object.defineProperty(dom.window.document, 'cookie', { configurable: true, get: refuse, set: refuse });
  }
  return { dom, run: (script: string): unknown => dom.window.eval(script) };
}

describe('storage in the preview sandbox', () => {
  it('is refused there without the stand-ins, as the reader saw', () => {
    const { run } = page();
    expect(() => run('localStorage.getItem("token")')).toThrow(/opaque|SecurityError/i);
    expect(() => run('document.cookie')).toThrow(/sandboxed/);
  });

  it('keeps what a page stores while it is open, as a Storage does', () => {
    const { run } = page();
    run(PREVIEW_STORAGE_SCRIPT);
    // What a login page does with its token, and the other ways pages reach a Storage.
    run('localStorage.setItem("jwt", "abc"); localStorage.setItem("n", 7); localStorage.theme = "dark";');
    expect(run('localStorage.getItem("jwt")')).toBe('abc');
    expect(run('localStorage.getItem("n")')).toBe('7');
    expect(run('localStorage["theme"]')).toBe('dark');
    expect(run('localStorage.getItem("missing")')).toBeNull();
    expect(run('localStorage.missing')).toBeUndefined();
    expect(run('localStorage.length')).toBe(3);
    expect(run('[0, 1, 2, 3].map(i => localStorage.key(i))')).toEqual(['jwt', 'n', 'theme', null]);
    expect(run('Object.keys(localStorage)')).toEqual(['jwt', 'n', 'theme']);
    expect(run('JSON.stringify(localStorage)')).toBe('{"jwt":"abc","n":"7","theme":"dark"}');
    expect(run('"jwt" in localStorage && "getItem" in localStorage && !("gone" in localStorage)')).toBe(true);
    run('localStorage.removeItem("jwt"); delete localStorage.theme;');
    expect(run('Object.keys(localStorage)')).toEqual(['n']);
    run('localStorage.clear()');
    expect(run('localStorage.length')).toBe(0);
    // A setItem named like a method stores a value and leaves the method alone.
    run('localStorage.setItem("getItem", "x")');
    expect(run('localStorage.getItem("getItem")')).toBe('x');
    // sessionStorage is its own, and window.localStorage is the same one the page reaches by its bare name.
    run('sessionStorage.setItem("step", "2")');
    expect(run('sessionStorage.getItem("step")')).toBe('2');
    expect(run('localStorage.getItem("step")')).toBeNull();
    expect(run('window.localStorage === localStorage && window.sessionStorage !== localStorage')).toBe(true);
  });

  // Review: a page a stand-in broke where the real Storage would not have would go back for repair all the same.
  it('keeps a Storage’s rules where a page uses it as an object', () => {
    const { run } = page();
    run(PREVIEW_STORAGE_SCRIPT);
    // A string key defined on it is an item, and a definition the real one refuses is refused, without breaking it.
    run('Object.defineProperty(localStorage, "foo", { value: "bar" })');
    expect(run('localStorage.getItem("foo")')).toBe('bar');
    expect(run('Object.keys(localStorage)')).toEqual(['foo']);
    expect(run('(() => { try { Object.defineProperty(localStorage, "g", { get: () => 1 }); return "defined" } catch (e) { return e.name } })()')).toBe('TypeError');
    expect(run('Object.keys(localStorage)')).toEqual(['foo']);
    // Writing a method's name stores an item and leaves the method; its name reads the method, and is not listed.
    run('localStorage.getItem = "x"; localStorage.length = 9');
    expect(run('typeof localStorage.getItem')).toBe('function');
    expect(run('localStorage.getItem("getItem") + "/" + localStorage.getItem("length")')).toBe('x/9');
    expect(run('localStorage.length')).toBe(3);
    expect(run('Object.keys(localStorage)')).toEqual(['foo']);
    // Neither its prototype nor its extensibility can be taken from it.
    run('localStorage.__proto__ = null; try { Object.preventExtensions(localStorage) } catch (e) {} ; try { Object.setPrototypeOf(localStorage, null) } catch (e) {}');
    expect(run('typeof localStorage.setItem === "function" && Object.isExtensible(localStorage) && Object.entries(localStorage).length === 1')).toBe(true);
    expect(run('({ ...localStorage }).foo')).toBe('bar');
  });

  it('keeps cookies as name=value pairs, and drops one that has expired', () => {
    const { run } = page();
    run(PREVIEW_STORAGE_SCRIPT);
    run('document.cookie = "sid=s1; path=/; SameSite=Lax"; document.cookie = "lang=zh"; document.cookie = "lang=en"');
    expect(run('document.cookie')).toBe('sid=s1; lang=en');
    // Any date in the past expires it, as cookie libraries write one; Max-Age wins over Expires; 0123 is 123 seconds.
    run('document.cookie = "sid=; expires=" + new Date(Date.now() - 86400000).toUTCString()');
    expect(run('document.cookie')).toBe('lang=en');
    run('document.cookie = "a=1; Max-Age=0123"; document.cookie = "b=2; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT"; document.cookie = "lang=; Max-Age=-1"');
    expect(run('document.cookie')).toBe('a=1; b=2');
    // One that runs out while the page is open is gone when it is read next.
    run('document.cookie = "c=3; Max-Age=1"');
    expect(run('document.cookie')).toBe('a=1; b=2; c=3');
    return new Promise<void>(done => setTimeout(() => { expect(run('document.cookie')).toBe('a=1; b=2'); done(); }, 1100));
  });

  it('leaves storage the browser does give the page alone', () => {
    const { dom, run } = page('https://pages.example.test/');
    const real = dom.window.localStorage;
    run(PREVIEW_STORAGE_SCRIPT);
    expect(dom.window.localStorage).toBe(real);
    run('localStorage.setItem("k", "v"); document.cookie = "a=1"');
    expect(real.getItem('k')).toBe('v');
    expect(run('document.cookie')).toBe('a=1');
  });

  it('runs first, so a page that reads its token at its first line starts', () => {
    const { run } = page();
    run(PREVIEW_HOST_SCRIPT);
    expect(run('(() => { const token = localStorage.getItem("awwo.jwt"); return token === null ? "signed out" : token; })()')).toBe('signed out');
  });
});
