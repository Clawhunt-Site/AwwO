import { useEffect, useRef, useState } from 'react';
import type { Object3D, Material, Texture } from 'three';
import { validateModel, type PreviewFile } from './previewData';

/** Real WebGL renderer. A failed context produces an error, never a substitute picture. */
export function ModelPreview({ file }: { file: PreviewFile }) {
  const host = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => undefined);
  const [status, setStatus] = useState('正在加载 3D 模型…');
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false; let cleanup = () => undefined; let object: Object3D | undefined;
    const disposeObject = (root?: Object3D) => {
      const textures = new Set<Texture>(); const materials = new Set<Material>();
      root?.traverse(node => {
        const mesh = node as Object3D & { geometry?: { dispose(): void }; material?: Material | Material[] };
        mesh.geometry?.dispose();
        for (const material of mesh.material ? Array.isArray(mesh.material) ? mesh.material : [mesh.material] : []) {
          materials.add(material);
          for (const value of Object.values(material)) if (value && typeof value === 'object' && (value as Texture).isTexture) textures.add(value as Texture);
        }
      });
      for (const texture of textures) { (texture.image as { close?: () => void } | undefined)?.close?.(); texture.dispose(); }
      for (const material of materials) material.dispose();
    };
    setStatus('正在加载 3D 模型…'); setError('');
    void (async () => {
      try {
        const content = validateModel(file);
        const [THREE, { OrbitControls }, { GLTFLoader }, { OBJLoader }] = await Promise.all([
          import('three'), import('three/examples/jsm/controls/OrbitControls.js'), import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/loaders/OBJLoader.js'),
        ]);
        if (disposed || !host.current) return;
        const target = host.current;
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        const scene = new THREE.Scene(); scene.background = new THREE.Color('#f1f4f2');
        const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false; controls.minDistance = 0.05;
        scene.add(new THREE.HemisphereLight(0xffffff, 0x536552, 2.8));
        const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(4, 6, 5); scene.add(light);
        const paint = () => { if (!disposed) renderer.render(scene, camera); };
        const resize = () => {
          if (disposed) return;
          const width = Math.max(target.clientWidth, 1); const height = Math.max(target.clientHeight, 1);
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(width, height);
          camera.aspect = width / height; camera.updateProjectionMatrix(); paint();
        };
        const lost = (event: Event) => { event.preventDefault(); if (!disposed) setError('WebGL 上下文已丢失，请重新选择文件'); };
        renderer.domElement.addEventListener('webglcontextlost', lost);
        renderer.domElement.setAttribute('aria-label', `${file.name} 3D 模型，拖动旋转、滚轮缩放`);
        renderer.domElement.setAttribute('role', 'img');
        target.appendChild(renderer.domElement);
        const observer = new ResizeObserver(resize); observer.observe(target);
        controls.addEventListener('change', paint);
        cleanup = () => {
          observer.disconnect(); controls.removeEventListener('change', paint); controls.dispose();
          renderer.domElement.removeEventListener('webglcontextlost', lost);
          disposeObject(object); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); reset.current = () => undefined;
        };
        resize();
        // Preflight rejects every externally supplied URI. Only loader-created blob URLs
        // (for embedded images) and the verified data URIs can pass the manager.
        const manager = new THREE.LoadingManager();
        manager.setURLModifier(url => { if (/^(?:data:|blob:)/.test(url)) return url; throw new Error('3D 预览不加载外部资源'); });
        object = content.format === 'obj' ? new OBJLoader(manager).parse(content.source as string)
          : (await new GLTFLoader(manager).parseAsync(content.source, '')).scene;
        if (disposed) { disposeObject(object); return; }
        if (content.format === 'obj') object.traverse(node => {
          if (node instanceof THREE.Mesh && !node.geometry.getAttribute('color')) {
            for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
              if ('color' in material) (material.color as import('three').Color).setHex(0x648caa);
            }
          }
        });
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) throw new Error('模型中没有可见几何体');
        const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
        const extent = Math.max(size.x, size.y, size.z);
        if (![center.x, center.y, center.z, extent].every(Number.isFinite) || extent <= 0) throw new Error('模型坐标无效');
        const normalized = new THREE.Group();
        object.position.sub(center); normalized.add(object); normalized.scale.setScalar(2 / extent); scene.add(normalized);
        const home = () => { camera.position.set(3.2, 2.4, 3.8); controls.target.set(0, 0, 0); controls.update(); paint(); };
        reset.current = home; home(); setStatus('');
      } catch (reason) {
        cleanup();
        if (!disposed) { setError(reason instanceof Error ? reason.message : '3D 渲染失败'); setStatus(''); }
      }
    })();
    return () => { disposed = true; cleanup(); };
  }, [file]);
  return <div className="awwo-model-preview">
    <div className="awwo-preview-controls"><span>拖动旋转 · 滚轮缩放</span><button type="button" onClick={() => reset.current()} disabled={!!status || !!error}>重置视角</button></div>
    <div className="awwo-model-stage" ref={host} />
    {status && <p role="status" className="awwo-preview-overlay">{status}</p>}
    {error && <p role="alert" className="awwo-preview-overlay">无法渲染：{error}</p>}
  </div>;
}
