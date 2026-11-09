// Screenshots for a report (FeedbackAssistant.tsx): any picture the person picks or pastes, redrawn as a JPEG small
// enough that a report with three of them stays under the API's limits (backend feedback.go: 450 KB each, 1 MB in all,
// and the edge's 2 MB for the whole request).

export type FeedbackShot = { id: string; type: 'image/jpeg'; data: string; preview: string; bytes: number };

export const SHOT_LIMIT = 3;
const MAX_BYTES = 330 * 1024;
const MAX_SIDE = 1600;

function load(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable picture')); };
    image.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('no picture')), 'image/jpeg', quality));
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('unreadable picture'));
    reader.readAsDataURL(blob);
  });
}

/** The picture redrawn on white (a transparent PNG would turn black as a JPEG) at most MAX_SIDE across, at the best
 *  quality that fits MAX_BYTES, smaller still if none does. */
export async function shrinkScreenshot(file: Blob): Promise<FeedbackShot> {
  if (!file.type.startsWith('image/')) throw new Error('not a picture');
  const image = await load(file);
  let scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.74, 0.6]) {
      const blob = await encode(canvas, quality);
      if (blob.size <= MAX_BYTES) {
        const data = await base64(blob);
        return { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, type: 'image/jpeg', data,
          preview: `data:image/jpeg;base64,${data}`, bytes: blob.size };
      }
    }
    scale *= 0.72;
  }
  throw new Error('picture too large');
}
