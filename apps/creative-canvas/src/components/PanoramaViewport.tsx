import { useEffect, useRef, useState } from 'react';

interface Renderer {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  yaw: WebGLUniformLocation;
  pitch: WebGLUniformLocation;
  fov: WebGLUniformLocation;
  aspect: WebGLUniformLocation;
  hasTexture: WebGLUniformLocation;
  imageReady: boolean;
}

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  varying vec2 vPosition;
  void main() {
    vPosition = aPosition;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 vPosition;
  uniform sampler2D uTexture;
  uniform float uYaw;
  uniform float uPitch;
  uniform float uFov;
  uniform float uAspect;
  uniform float uHasTexture;
  const float PI = 3.141592653589793;

  mat3 rotateY(float angle) {
    float c = cos(angle); float s = sin(angle);
    return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  }
  mat3 rotateX(float angle) {
    float c = cos(angle); float s = sin(angle);
    return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
  }
  void main() {
    float focal = tan(radians(uFov) * 0.5);
    vec3 direction = normalize(vec3(vPosition.x * focal * uAspect, vPosition.y * focal, -1.0));
    direction = rotateY(uYaw) * rotateX(uPitch) * direction;
    float longitude = atan(direction.x, -direction.z);
    float latitude = asin(clamp(direction.y, -1.0, 1.0));
    vec2 uv = vec2(fract(longitude / (2.0 * PI) + 0.5), latitude / PI + 0.5);
    if (uHasTexture > 0.5) {
      gl_FragColor = texture2D(uTexture, vec2(uv.x, 1.0 - uv.y));
    } else {
      float lonGrid = smoothstep(0.94, 1.0, abs(sin(longitude * 6.0)));
      float latGrid = smoothstep(0.94, 1.0, abs(sin(latitude * 12.0)));
      vec3 base = mix(vec3(0.035, 0.05, 0.12), vec3(0.10, 0.16, 0.28), uv.y);
      vec3 grid = vec3(0.18, 0.78, 0.95) * max(lonGrid, latGrid) * 0.48;
      float horizon = smoothstep(0.08, 0.0, abs(latitude));
      gl_FragColor = vec4(base + grid + horizon * vec3(0.42, 0.23, 0.62), 1.0);
    }
  }
`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL shader unavailable');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'WebGL compile failed');
  return shader;
}

function draw(renderer: Renderer, yaw: number, pitch: number, fov: number, width: number, height: number) {
  const { gl, program } = renderer;
  gl.viewport(0, 0, width, height);
  gl.useProgram(program);
  gl.uniform1f(renderer.yaw, yaw);
  gl.uniform1f(renderer.pitch, pitch);
  gl.uniform1f(renderer.fov, fov);
  gl.uniform1f(renderer.aspect, width / height);
  gl.uniform1f(renderer.hasTexture, renderer.imageReady ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

export function PanoramaViewport({
  imageUrl,
  yaw,
  pitch,
  fov,
  onViewChange,
}: {
  imageUrl: string | null;
  yaw: number;
  pitch: number;
  fov: number;
  onViewChange: (view: { yaw: number; pitch: number; fov: number }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) {
      setError('当前设备无法启动 WebGL 全景预览');
      return;
    }
    try {
      const program = gl.createProgram();
      if (!program) throw new Error('WebGL program unavailable');
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
      gl.linkProgram(program);
      const buffer = gl.createBuffer();
      const texture = gl.createTexture();
      if (!buffer || !texture) throw new Error('WebGL buffer unavailable');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      rendererRef.current = {
        gl,
        program,
        texture,
        yaw: gl.getUniformLocation(program, 'uYaw')!,
        pitch: gl.getUniformLocation(program, 'uPitch')!,
        fov: gl.getUniformLocation(program, 'uFov')!,
        aspect: gl.getUniformLocation(program, 'uAspect')!,
        hasTexture: gl.getUniformLocation(program, 'uHasTexture')!,
        imageReady: false,
      };
      draw(rendererRef.current, yaw, pitch, fov, canvas.width, canvas.height);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'WebGL 初始化失败');
    }
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas) return;
    renderer.imageReady = false;
    if (!imageUrl) {
      draw(renderer, yaw, pitch, fov, canvas.width, canvas.height);
      return;
    }
    const image = new Image();
    image.onload = () => {
      const { gl, texture } = renderer;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      renderer.imageReady = true;
      draw(renderer, yaw, pitch, fov, canvas.width, canvas.height);
    };
    image.onerror = () => setError('全景图读取失败，请换一张本地图片');
    image.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (renderer && canvas) draw(renderer, yaw, pitch, fov, canvas.width, canvas.height);
  }, [yaw, pitch, fov]);

  const exportView = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `superclaw-vr360-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  if (error) return <div className="panorama-error" role="status">{error}</div>;
  return (
    <div className="panorama-shell">
      <canvas
        ref={canvasRef}
        className="panorama-canvas"
        width={720}
        height={400}
        aria-label="VR360 可交互全景预览，拖动旋转视角"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, yaw, pitch };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          onViewChange({
            yaw: drag.yaw + (event.clientX - drag.x) * 0.007,
            pitch: Math.max(-1.2, Math.min(1.2, drag.pitch - (event.clientY - drag.y) * 0.005)),
            fov,
          });
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
      />
      <button className="panorama-export" type="button" onClick={exportView}>导出当前视角</button>
    </div>
  );
}
