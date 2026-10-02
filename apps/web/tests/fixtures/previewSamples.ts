import { strToU8, zipSync } from 'fflate';
import type { PreviewFile, PreviewKind } from '../../src/canvas/previewData';

/** Small real files of each preview kind, generated for the viewer tests. */
export function previewSample(kind: PreviewKind): PreviewFile {
  if (kind === 'html') return { name: 'local-demo.html', bytes: strToU8('<!doctype html><html><head><title>Local preview example</title></head><body style="background:#edf5f0;padding:32px;font-family:system-ui"><small>LOCAL DEMO · 本地演示</small><h1>Ideas become artifacts.</h1><p>这是在浏览器本地生成的 HTML 演示，不是任务交付物。</p><div style="background:white;padding:20px;border-radius:16px"><h2>Build · Review · Learn</h2><p>上传你的 HTML 文件即可检查实际内容。</p><button onclick="this.textContent=\'交互成功 · 本地演示\'" style="padding:12px;background:#2d6652;color:white;border:0;border-radius:8px">测试交互</button></div></body></html>') };
  if (kind === 'model') return { name: 'local-demo.obj', bytes: strToU8('# Local demo: a cube. Not a task output.\no DemoCube\nv -1 -1 -1\nv 1 -1 -1\nv 1 1 -1\nv -1 1 -1\nv -1 -1 1\nv 1 -1 1\nv 1 1 1\nv -1 1 1\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 4 8 7 3\nf 1 5 8 4\nf 2 3 7 6\n') };
  if (kind === 'ide') return { name: 'local-demo-workspace.zip', bytes: zipSync({
    'README.md': strToU8('# Local demo workspace\n\nGenerated only for preview. Not a task result.\n'),
    'src/main.ts': strToU8('interface Preview { title: string; ready: boolean }\n\nexport const preview: Preview = {\n  title: "AwwO local demo",\n  ready: true,\n};\n'),
    'src/style.css': strToU8(':root { color: #244e3c; background: #f4f8f5; }\n'),
  }) };
  const streams = ['BT /F1 22 Tf 45 720 Td (AwwO - LOCAL DEMO) Tj 0 -42 Td /F1 12 Tf (Page 1: This PDF was generated locally for preview.) Tj 0 -22 Td (It is not a task output.) Tj ET', 'BT /F1 22 Tf 45 720 Td (LOCAL DEMO - PAGE 2) Tj 0 -42 Td /F1 12 Tf (Page navigation renders actual PDF pages.) Tj ET'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', ...streams.map(stream => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name: 'local-demo.pdf', bytes: strToU8(pdf) };
}
