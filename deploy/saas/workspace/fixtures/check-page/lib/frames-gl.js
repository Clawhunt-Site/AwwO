// A piece written for AwwO's renderer: ready at once, and renderAt(t) draws the whole frame from t alone. Each frame is
// exactly three draw calls: a quad (2 triangles), five instances of one triangle (5 triangles) and a line strip of four
// points (3 lines), so --frames can be held to those numbers. The page that loads this may set window.FIXTURE_MODE: 'still' draws every frame as t = 0, 'throw' throws from 2 s on.
const mode = window.FIXTURE_MODE;
const gl = document.getElementById('scene').getContext('webgl2');
if (!gl) throw new Error('fixture: WebGL 2 is not available');
const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
const program = gl.createProgram();
gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
in vec2 p; uniform float turn; uniform vec2 shift; uniform float size;
void main() { float c = cos(turn + float(gl_InstanceID)), s = sin(turn + float(gl_InstanceID));
  gl_Position = vec4(mat2(c, s, -s, c) * p * size + shift + vec2(float(gl_InstanceID) * 0.3, 0.0), 0.0, 1.0); }`));
gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; uniform vec3 tint; out vec4 colour; void main() { colour = vec4(tint, 1.0); }`));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`fixture: ${gl.getProgramInfoLog(program)}`);
gl.useProgram(program);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,   // the quad
  -1, -0.8, 1, -0.8, 0, 1,                    // the triangle
  -1, 0, -0.3, 0.6, 0.3, -0.6, 1, 0,          // the line strip
]), gl.STATIC_DRAW);
const position = gl.getAttribLocation(program, 'p');
gl.enableVertexAttribArray(position);
gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
const set = (turn, x, y, size, tint) => {
  gl.uniform1f(gl.getUniformLocation(program, 'turn'), turn); gl.uniform2f(gl.getUniformLocation(program, 'shift'), x, y);
  gl.uniform1f(gl.getUniformLocation(program, 'size'), size); gl.uniform3fv(gl.getUniformLocation(program, 'tint'), tint);
};
const draw = t => {
  gl.clearColor(0.05, 0.06, 0.09, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  set(0, 0, -0.55, 0.3, [0.14, 0.18, 0.26]);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  set(t * 0.9, -0.6, 0.2, 0.16, [0.95, 0.55, 0.12]);
  gl.drawArraysInstanced(gl.TRIANGLES, 6, 3, 5);
  set(t * 0.3, 0, -0.55, 0.5, [0.55, 0.85, 1]);
  gl.drawArrays(gl.LINE_STRIP, 9, 4);
};
window.__ready = true;
window.renderAt = t => {
  if (mode === 'throw' && t >= 2) throw new Error('fixture: the rig has no pose after 2 s');
  draw(mode === 'still' ? 0 : t);
};
draw(0);
