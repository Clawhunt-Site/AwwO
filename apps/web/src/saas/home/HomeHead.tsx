// The home's head, in the middle of 首页 above its title (owner 2026-11-08: 「这个中间为什么还是这个光秃秃的球，之前我们设计了
// 一堆icon和动态图标的，换过来吧」). It is the head every loading page shows (BootHead: the boot head's plate, collar and
// face, saas.html's static rules, a converged canvas's flat head), so the page grows out of its own loading head; here
// at rest and alive: the calm eyes (AVATAR_FACES.calm) glance aside and blink now and then, and no arc goes round,
// because nothing is loading. Its loops are its own (system.css, saas-home-*), so the boot head's phase lock
// (lockBootPhase, awwo-boot-* only) leaves them alone; it is still where the reader asks for reduced motion.
import { AVATAR_CRESCENT, AVATAR_FACES } from '../../canvas/avatarFace';

export function HomeHead() {
  return <div className="awwo-boot-head saas-home-head" aria-hidden="true">
    <span className="awwo-boot-plate" />
    <svg className="awwo-boot-ring" viewBox="-60 -60 120 120"><circle className="awwo-boot-collar" r="52" /></svg>
    <span className="awwo-boot-face">
      <svg className="awwo-boot-crescent" viewBox="0 0 100 100"><path d={AVATAR_CRESCENT} /></svg>
      <span className="awwo-boot-rim" />
      <span className="awwo-boot-gaze"><span className="awwo-boot-blink"><svg viewBox="0 0 100 100">
        {AVATAR_FACES.calm.map((eye, index) => eye.shape === 'capsule'
          ? <rect key={index} x={eye.cx - eye.w / 2} y={eye.cy - eye.h / 2} width={eye.w} height={eye.h} rx={Math.min(eye.w, eye.h) / 2} />
          : null)}
      </svg></span></span>
    </span>
  </div>;
}
