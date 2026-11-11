// No renderAt: --frames shows this page t seconds after its load, on the real clock. A bar grows with the seconds
// since the load, so later frames differ from earlier ones; it is 2D canvas, so no WebGL draw is counted. The page
// that loads this may set window.FIXTURE_MODE to 'black': it then paints nothing but black from 3 s on, after the
// check's own screenshot (1.5 s after the load), so only a frame taken later is one the check calls blank.
const ctx = document.getElementById('stage').getContext('2d'), started = performance.now();
const black = window.FIXTURE_MODE === 'black';
requestAnimationFrame(function frame(now) {
  const t = (now - started) / 1000;
  ctx.fillStyle = '#10141a'; ctx.fillRect(0, 0, 640, 400);
  if (black && t > 3) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 400); document.documentElement.style.background = document.body.style.background = '#000'; }
  else {
    ctx.fillStyle = '#3b82f6'; ctx.fillRect(40, 160, Math.min(560, 60 + t * 120), 80);
    ctx.fillStyle = '#f3efe6'; ctx.font = '20px sans-serif'; ctx.fillText('the bar grows with the clock', 40, 120);
  }
  requestAnimationFrame(frame);
});
