// Image clean-up for silhouettes.
// Decodes every frame of a GIF / WebP / APNG / PNG, turns each frame into a
// crisp two-tone shape (solid inside, empty outside), fills small holes left
// by background-removal tools, removes stray specks, and packs the frames
// into one PNG "sheet" that the extension plays back itself.

const MAX_FRAMES = 120;
const MAX_FRAME_HEIGHT = 480;
const MAX_SHEET_SIDE = 4096;
const ALPHA_CUTOFF = 110;      // pixels below this opacity count as empty
const HOLE_FILL_SHARE = 0.015; // fill enclosed holes smaller than 1.5% of the frame
const SPECK_SHARE = 0.0004;    // remove solid islands smaller than 0.04% of the frame

export function canCleanUp() {
    return typeof globalThis.ImageDecoder === 'function';
}

function mimeFor(name, fallback) {
    const ext = (String(name).match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    return {
        gif: 'image/gif', webp: 'image/webp', png: 'image/png', apng: 'image/png',
        avif: 'image/avif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    }[ext] ?? fallback ?? 'image/gif';
}

// Labels 4-connected regions of pixels where mask[i] === want.
// Calls visit(pixels, touchesBorder) for each region.
function regions(mask, w, h, want, visit) {
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    for (let start = 0; start < w * h; start++) {
        if (seen[start] || mask[start] !== want) continue;
        let head = 0;
        let tail = 0;
        let border = false;
        queue[tail++] = start;
        seen[start] = 1;
        while (head < tail) {
            const p = queue[head++];
            const x = p % w;
            const y = (p - x) / w;
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
            if (x > 0 && !seen[p - 1] && mask[p - 1] === want) { seen[p - 1] = 1; queue[tail++] = p - 1; }
            if (x < w - 1 && !seen[p + 1] && mask[p + 1] === want) { seen[p + 1] = 1; queue[tail++] = p + 1; }
            if (y > 0 && !seen[p - w] && mask[p - w] === want) { seen[p - w] = 1; queue[tail++] = p - w; }
            if (y < h - 1 && !seen[p + w] && mask[p + w] === want) { seen[p + w] = 1; queue[tail++] = p + w; }
        }
        visit(queue.subarray(0, tail), border);
    }
}

// Cleans one frame in place: returns which image edges the shape touches.
function cleanFrame(img) {
    const { width: w, height: h, data } = img;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3] >= ALPHA_CUTOFF ? 1 : 0;

    const area = w * h;
    const maxHole = Math.max(16, Math.round(area * HOLE_FILL_SHARE));
    const maxSpeck = Math.max(4, Math.round(area * SPECK_SHARE));

    // Remove tiny solid specks floating outside the figure.
    regions(mask, w, h, 1, (px) => {
        if (px.length <= maxSpeck) for (const p of px) mask[p] = 0;
    });
    // Fill small empty holes fully enclosed by the figure.
    regions(mask, w, h, 0, (px, border) => {
        if (!border && px.length <= maxHole) for (const p of px) mask[p] = 1;
    });

    let top = false;
    let bottom = false;
    for (let x = 0; x < w; x++) {
        if (mask[x]) top = true;
        if (mask[(h - 1) * w + x]) bottom = true;
    }
    for (let i = 0; i < area; i++) {
        const o = i * 4;
        data[o] = data[o + 1] = data[o + 2] = 255;
        data[o + 3] = mask[i] ? 255 : 0;
    }
    return { top, bottom };
}

// file: a File/Blob. Returns { blob (PNG sheet), meta } or throws.
export async function buildSheet(file, onProgress) {
    if (!canCleanUp()) throw new Error('this browser cannot decode animation frames');
    const type = mimeFor(file.name, file.type);
    if (globalThis.ImageDecoder.isTypeSupported && !(await globalThis.ImageDecoder.isTypeSupported(type))) {
        throw new Error(`can't decode ${type}`);
    }
    const decoder = new globalThis.ImageDecoder({ data: await file.arrayBuffer(), type });
    try {
        await decoder.tracks.ready;
        await decoder.completed?.catch?.(() => {});
        const total = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
        const step = total > MAX_FRAMES ? total / MAX_FRAMES : 1;
        const picks = [];
        for (let f = 0; f < total && picks.length < MAX_FRAMES; f += step) picks.push(Math.floor(f));

        // First frame decides the frame size.
        const first = (await decoder.decode({ frameIndex: picks[0] })).image;
        const srcW = first.displayWidth;
        const srcH = first.displayHeight;
        first.close();
        let fh = Math.min(srcH, MAX_FRAME_HEIGHT);
        let fw = Math.max(1, Math.round(srcW * (fh / srcH)));
        const n = picks.length;
        let cols = Math.max(1, Math.ceil(Math.sqrt((n * fh) / fw)));
        let rows = Math.ceil(n / cols);
        const over = Math.max((cols * fw) / MAX_SHEET_SIDE, (rows * fh) / MAX_SHEET_SIDE, 1);
        if (over > 1) {
            fw = Math.max(1, Math.floor(fw / over));
            fh = Math.max(1, Math.floor(fh / over));
            cols = Math.max(1, Math.ceil(Math.sqrt((n * fh) / fw)));
            rows = Math.ceil(n / cols);
        }

        const sheet = document.createElement('canvas');
        sheet.width = cols * fw;
        sheet.height = rows * fh;
        const sctx = sheet.getContext('2d');
        const work = document.createElement('canvas');
        work.width = fw;
        work.height = fh;
        const wctx = work.getContext('2d', { willReadFrequently: true });

        const durations = [];
        let touchTop = false;
        let touchBottom = false;
        for (let k = 0; k < n; k++) {
            const { image } = await decoder.decode({ frameIndex: picks[k] });
            // Frame duration in ms; when frames were skipped, stretch to keep the same speed.
            const us = image.duration ?? 100000;
            durations.push(Math.max(20, Math.round((us / 1000) * step)));
            wctx.clearRect(0, 0, fw, fh);
            wctx.drawImage(image, 0, 0, fw, fh);
            image.close();
            const img = wctx.getImageData(0, 0, fw, fh);
            const edges = cleanFrame(img);
            touchTop ||= edges.top;
            touchBottom ||= edges.bottom;
            wctx.putImageData(img, 0, 0);
            sctx.drawImage(work, (k % cols) * fw, Math.floor(k / cols) * fh);
            onProgress?.(k + 1, n);
            if (k % 8 === 7) await new Promise(r => setTimeout(r, 0)); // keep the page responsive
        }
        const blob = await new Promise((res, rej) => sheet.toBlob(b => (b ? res(b) : rej(new Error('could not create the sheet'))), 'image/png'));
        return { blob, meta: { cols, rows, n, fw, fh, durations, touchTop, touchBottom } };
    } finally {
        decoder.close();
    }
}
