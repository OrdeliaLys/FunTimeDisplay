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

    // Which image edges the shape touches, and the box around the shape.
    let top = false;
    let bottom = false;
    let left = false;
    let right = false;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!mask[y * w + x]) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX >= 0) {
        for (let x = 0; x < w; x++) {
            if (mask[x]) top = true;
            if (mask[(h - 1) * w + x]) bottom = true;
        }
        for (let y = 0; y < h; y++) {
            if (mask[y * w]) left = true;
            if (mask[y * w + w - 1]) right = true;
        }
    }
    for (let i = 0; i < area; i++) {
        const o = i * 4;
        data[o] = data[o + 1] = data[o + 2] = 255;
        data[o + 3] = mask[i] ? 255 : 0;
    }
    return { top, bottom, left, right, minX, minY, maxX, maxY };
}

// file: a File/Blob. crop: optional { l, t, r, b } fractions (0..0.45) cut
// from each side first. Returns { blob (PNG sheet), meta } or throws.
// The frames are trimmed to the figure (the empty space around it is
// dropped), and meta records which sides the figure is cut off at.
export async function buildSheet(file, onProgress, crop) {
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
        const n = picks.length;

        const first = (await decoder.decode({ frameIndex: picks[0] })).image;
        const srcW = first.displayWidth;
        const srcH = first.displayHeight;
        first.close();
        const c = { l: 0, t: 0, r: 0, b: 0, ...(crop ?? {}) };
        const sx = Math.round(srcW * c.l);
        const sy = Math.round(srcH * c.t);
        const sw = Math.max(1, Math.round(srcW * (1 - c.l - c.r)));
        const sh = Math.max(1, Math.round(srcH * (1 - c.t - c.b)));
        // Working size for cleaning (the cropped area, at most 480 tall).
        const wh = Math.min(sh, MAX_FRAME_HEIGHT);
        const ww = Math.max(1, Math.round(sw * (wh / sh)));
        const work = document.createElement('canvas');
        work.width = ww;
        work.height = wh;
        const wctx = work.getContext('2d', { willReadFrequently: true });
        const cleaned = async (k) => {
            const { image } = await decoder.decode({ frameIndex: picks[k] });
            const us = image.duration ?? 100000;
            wctx.clearRect(0, 0, ww, wh);
            wctx.drawImage(image, sx, sy, sw, sh, 0, 0, ww, wh);
            image.close();
            const img = wctx.getImageData(0, 0, ww, wh);
            const info = cleanFrame(img);
            return { img, info, ms: Math.max(20, Math.round((us / 1000) * step)) };
        };

        // Pass 1: find the box around the figure over all frames, and its cut sides.
        let minX = ww, minY = wh, maxX = -1, maxY = -1;
        let touchTop = false, touchBottom = false, touchLeft = false, touchRight = false;
        const durations = [];
        for (let k = 0; k < n; k++) {
            const { info, ms } = await cleaned(k);
            durations.push(ms);
            if (info.maxX >= 0) {
                minX = Math.min(minX, info.minX); minY = Math.min(minY, info.minY);
                maxX = Math.max(maxX, info.maxX); maxY = Math.max(maxY, info.maxY);
            }
            touchTop ||= info.top; touchBottom ||= info.bottom; touchLeft ||= info.left; touchRight ||= info.right;
            onProgress?.(k + 1, n * 2);
            if (k % 8 === 7) await new Promise(r => setTimeout(r, 0));
        }
        if (maxX < 0) throw new Error('no figure found (is the background transparent?)');
        // A little room around the figure, except on sides where it's cut off.
        const pad = Math.round(Math.max(ww, wh) * 0.02);
        const bx = touchLeft ? 0 : Math.max(0, minX - pad);
        const by = touchTop ? 0 : Math.max(0, minY - pad);
        const bx2 = touchRight ? ww - 1 : Math.min(ww - 1, maxX + pad);
        const by2 = touchBottom ? wh - 1 : Math.min(wh - 1, maxY + pad);
        let fw = bx2 - bx + 1;
        let fh = by2 - by + 1;

        let cols = Math.max(1, Math.ceil(Math.sqrt((n * fh) / fw)));
        let rows = Math.ceil(n / cols);
        let scale = 1 / Math.max((cols * fw) / MAX_SHEET_SIDE, (rows * fh) / MAX_SHEET_SIDE, 1);
        const outW = Math.max(1, Math.floor(fw * scale));
        const outH = Math.max(1, Math.floor(fh * scale));
        cols = Math.max(1, Math.ceil(Math.sqrt((n * outH) / outW)));
        rows = Math.ceil(n / cols);

        const sheet = document.createElement('canvas');
        sheet.width = cols * outW;
        sheet.height = rows * outH;
        const sctx = sheet.getContext('2d');

        // Pass 2: clean again and copy the figure's box into the sheet.
        for (let k = 0; k < n; k++) {
            const { img } = await cleaned(k);
            wctx.putImageData(img, 0, 0);
            sctx.drawImage(work, bx, by, fw, fh, (k % cols) * outW, Math.floor(k / cols) * outH, outW, outH);
            onProgress?.(n + k + 1, n * 2);
            if (k % 8 === 7) await new Promise(r => setTimeout(r, 0));
        }
        const blob = await new Promise((res, rej) => sheet.toBlob(b => (b ? res(b) : rej(new Error('could not create the sheet'))), 'image/png'));
        return { blob, meta: { cols, rows, n, fw: outW, fh: outH, durations, touchTop, touchBottom, touchLeft, touchRight } };
    } finally {
        decoder.close();
    }
}
