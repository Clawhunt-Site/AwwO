import { useEffect, useRef } from 'react';

import type { Director3DNodeData } from '../types';

interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
}

export function Director3DStage({
  data,
  onViewChange,
  onCapture,
}: {
  data: Director3DNodeData;
  onViewChange: (view: Partial<Pick<Director3DNodeData, 'cameraYaw' | 'cameraPitch' | 'cameraDistance'>>) => void;
  onCapture: (previewDataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onViewChange({ cameraDistance: Math.max(4, Math.min(14, data.cameraDistance + event.deltaY * 0.01)) });
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [data.cameraDistance, onViewChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = 720;
    const height = 390;
    canvas.width = width;
    canvas.height = height;

    const palette = data.scenePreset === '雨夜街道'
      ? ['#07131c', '#0e3346', '#65d9ff']
      : data.scenePreset === '摄影棚'
        ? ['#0e1017', '#252b39', '#e9edf8']
        : ['#100c16', '#342038', '#ffbd6e'];
    const background = context.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, palette[0]);
    background.addColorStop(1, '#060812');
    context.globalAlpha = data.backgroundDataUrl ? 0.72 : 1;
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;

    const yaw = data.cameraYaw * Math.PI / 180;
    const pitch = data.cameraPitch * Math.PI / 180;
    const project = (x: number, y: number, z: number): ProjectedPoint => {
      const rotatedX = x * Math.cos(yaw) - z * Math.sin(yaw);
      const yawDepth = x * Math.sin(yaw) + z * Math.cos(yaw);
      const rotatedY = y * Math.cos(pitch) - yawDepth * Math.sin(pitch);
      const depth = data.cameraDistance + y * Math.sin(pitch) + yawDepth * Math.cos(pitch);
      const scale = (data.lensMm / 35) * 245 / Math.max(1.4, depth);
      return { x: width / 2 + rotatedX * scale, y: height * 0.64 - rotatedY * scale, visible: depth > 1 };
    };
    const line = (from: [number, number, number], to: [number, number, number], color: string, alpha = 1) => {
      const a = project(...from);
      const b = project(...to);
      if (!a.visible || !b.visible) return;
      context.globalAlpha = alpha;
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      context.globalAlpha = 1;
    };

    for (let grid = -8; grid <= 8; grid += 1) {
      line([grid, 0, -8], [grid, 0, 8], palette[1], grid === 0 ? 0.8 : 0.34);
      line([-8, 0, grid], [8, 0, grid], palette[1], grid === 0 ? 0.8 : 0.34);
    }
    line([-6, 0, 5], [-6, 5, 5], palette[1], 0.8);
    line([6, 0, 5], [6, 5, 5], palette[1], 0.8);
    line([-6, 5, 5], [6, 5, 5], palette[1], 0.8);

    const characters = data.characters.length > 0
      ? data.characters
      : [{ id: 'preview', name: '人物', color: '#f4f1ff', x: data.actorX, z: data.actorZ }];
    characters.forEach((character) => {
      const actorPoints = {
        head: project(character.x, 2.05, character.z),
        neck: project(character.x, 1.65, character.z),
        leftHand: project(character.x - 0.62, 1.05, character.z),
        rightHand: project(character.x + 0.62, 1.05, character.z),
        pelvis: project(character.x, 0.92, character.z),
        leftFoot: project(character.x - 0.3, 0, character.z),
        rightFoot: project(character.x + 0.3, 0, character.z),
      };
      const actorLine = (from: keyof typeof actorPoints, to: keyof typeof actorPoints) => {
        context.strokeStyle = character.color;
        context.lineWidth = 8;
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(actorPoints[from].x, actorPoints[from].y);
        context.lineTo(actorPoints[to].x, actorPoints[to].y);
        context.stroke();
      };
      actorLine('neck', 'leftHand');
      actorLine('neck', 'rightHand');
      actorLine('neck', 'pelvis');
      actorLine('pelvis', 'leftFoot');
      actorLine('pelvis', 'rightFoot');
      context.fillStyle = character.color;
      context.beginPath();
      context.arc(actorPoints.head.x, actorPoints.head.y, 15, 0, Math.PI * 2);
      context.fill();
    });

    const lightAngle = data.keyLightAngle * Math.PI / 180;
    const focusActor = characters[0];
    const light = project(focusActor.x + Math.cos(lightAngle) * 3, 4.3, focusActor.z + Math.sin(lightAngle) * 3);
    const lightGlow = context.createRadialGradient(light.x, light.y, 0, light.x, light.y, 100);
    lightGlow.addColorStop(0, `rgba(255, 204, 132, ${data.keyLightIntensity / 120})`);
    lightGlow.addColorStop(1, 'rgba(255, 190, 110, 0)');
    context.fillStyle = lightGlow;
    context.fillRect(light.x - 100, light.y - 100, 200, 200);

    context.fillStyle = 'rgba(7, 9, 16, 0.76)';
    context.fillRect(18, 18, 214, 58);
    context.fillStyle = '#ffbd6e';
    context.font = '700 12px ui-monospace, monospace';
    context.fillText(`CAM A · ${data.lensMm}MM · ${data.shotSize}`, 30, 42);
    context.fillStyle = '#aeb6cf';
    context.font = '11px ui-monospace, monospace';
    context.fillText(`YAW ${Math.round(data.cameraYaw)}°  PITCH ${Math.round(data.cameraPitch)}°`, 30, 61);
  }, [data]);

  const startOrbit = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const originYaw = data.cameraYaw;
    const originPitch = data.cameraPitch;
    const move = (pointerEvent: PointerEvent) => onViewChange({
      cameraYaw: originYaw + (pointerEvent.clientX - startX) * 0.35,
      cameraPitch: Math.max(-20, Math.min(55, originPitch + (pointerEvent.clientY - startY) * 0.25)),
    });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className="director-stage-shell"
      style={data.backgroundDataUrl ? { backgroundImage: `url(${data.backgroundDataUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
    >
      <canvas
        ref={canvasRef}
        className="director-stage-canvas"
        aria-label="可旋转的 3D 导演预演舞台"
        onPointerDown={startOrbit}
      />
      <span className="director-stage-hint">拖动环绕机位</span>
      <button
        type="button"
        className="director-stage-capture"
        onClick={() => {
          const canvas = canvasRef.current;
          if (canvas) onCapture(canvas.toDataURL('image/png'));
        }}
      >
        保存镜头方案
      </button>
    </div>
  );
}
