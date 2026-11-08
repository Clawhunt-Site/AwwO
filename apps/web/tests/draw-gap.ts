// React draws an update no input asked for (a fetch's answer, a stream's message, a timer) in a scheduler task, and runs
// that draw's effects in a later one: every commit asks for a paint, and the scheduler yields before the effects' task.
// A click or a key in between is handled first, and the draw's pending effects run as it is drawn, still holding the
// values of their own draw. `outsideAct` puts an input in that gap, as a browser does with one that arrives during the
// draw; a test shows the gap was hit with a witness (an effect counter, or what an effect saves, read at the input).

/** Outside act, as in a browser: `atTheDraw` is called in the microtasks after each change to the page's elements (added
 *  or removed) until it returns true, which is right after the draw it waits for and before that draw's effects. Whatever
 *  it and those effects scheduled is then drawn. If it throws, the wait ends with that error. `start`, when given, is run
 *  once the wait is set up (outside act too): the change that draws, for a test that makes it itself. */
export async function outsideAct(atTheDraw: () => boolean, start?: () => void) {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const observer = new MutationObserver(() => {
        let drawn: boolean;
        try { drawn = atTheDraw(); } catch (error) { observer.disconnect(); clearTimeout(giveUp); reject(error); return; }
        if (!drawn) return;
        observer.disconnect(); clearTimeout(giveUp); resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      giveUp = setTimeout(() => { observer.disconnect(); reject(new Error('The draw waited for never came.')); }, 5000);
      // A timer, so the change is made as a stream's message is: in a task of its own, with no input being handled.
      if (start) setTimeout(start, 0);
    });
    await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
  } finally { environment.IS_REACT_ACT_ENVIRONMENT = previous; }
}
