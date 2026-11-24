// DXF of a drawing sheet (for CAD programs): the sheet's SVG read back and
// written as AutoCAD R12 DXF, millimetres, y up. Lines, arcs and circles stay
// exact; text stays text; arrowheads are solids; the hatching of a section is
// written out as lines; a detail view is cut to its circle. Layers by kind of
// line: VISIBLE, THIN (dimensions, the frame, hatching), HIDDEN (dashed),
// CENTER (centrelines), TEXT.

type M = [number, number, number, number, number, number];
type P = [number, number];

const formatNumber = (value: number) => (Math.abs(value) < 1e-9 ? '0' : String(Math.round(value * 1e5) / 1e5));
const deg = (radians: number) => ((((radians * 180) / Math.PI) % 360) + 360) % 360;
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (matrix: M, point: P): P => [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]];
const ID: M = [1, 0, 0, 1, 0, 0];

/** A transform="…" (rotate and translate, as the sheet writes them). */
function transformOf(t: string | undefined): M {
  let matrix = ID;
  if (!t) {
    return matrix;
  }
  for (const [, kind, args] of t.matchAll(/(rotate|translate|matrix|scale)\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (kind === 'translate') {
      matrix = mul(matrix, [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]);
    } else if (kind === 'scale') {
      matrix = mul(matrix, [a[0], 0, 0, a[1] ?? a[0], 0, 0]);
    } else if (kind === 'matrix') {
      matrix = mul(matrix, a as M);
    } else {
      const angle = ((a[0] ?? 0) * Math.PI) / 180;
      const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
      matrix = mul(matrix, mul([1, 0, 0, 1, cx, cy], mul([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0], [1, 0, 0, 1, -cx, -cy])));
    }
  }

  return matrix;
}

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');

/** Text as R12 writes it: Ø ± ° as its codes, other letters past ASCII as \U+XXXX. */
const dxfText = (text: string) =>
  text.replace(/[^\x20-\x7e]/gu, char => (char === 'Ø' || char === 'ø' || char === '⌀' ? '%%c' : char === '±' ? '%%p' : char === '°' ? '%%d' : `\\U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`));

interface Style {
  stroke: string;
  width: number;
  dash: string;
  fill: string;
  m: M;
  /** Cut to this circle (a detail view). */
  clip?: { c: P; r: number };
  /** Filled with this hatch (its angle, degrees). */
  hatch?: number;
}

/** A segment a→b cut to a circle: the parts inside. */
function clipToCircle(a: P, b: P, center: P, radius: number): [P, P][] {
  const direction: P = [b[0] - a[0], b[1] - a[1]];
  const fromCenter: P = [a[0] - center[0], a[1] - center[1]];
  const quadA = direction[0] * direction[0] + direction[1] * direction[1];
  if (quadA < 1e-18) {
    return [];
  }
  const quadB = 2 * (fromCenter[0] * direction[0] + fromCenter[1] * direction[1]);
  const quadC = fromCenter[0] * fromCenter[0] + fromCenter[1] * fromCenter[1] - radius * radius;
  const disc = quadB * quadB - 4 * quadA * quadC;
  if (disc <= 0) {
    return [];
  }
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, (-quadB - root) / (2 * quadA));
  const t1 = Math.min(1, (-quadB + root) / (2 * quadA));
  if (t1 <= t0) {
    return [];
  }

  return [
    [
      [a[0] + direction[0] * t0, a[1] + direction[1] * t0],
      [a[0] + direction[0] * t1, a[1] + direction[1] * t1]
    ]
  ];
}

/** The sheet (its SVG, mm, y down, `height` tall) as a DXF file's text. */
export function sheetToDXF(svg: string): string {
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1].split(/\s+/).map(Number) ?? [0, 0, 420, 297];
  const height = vb[3];
  const flip = (point: P): P => [point[0], height - point[1]];
  const out: string[] = [];
  const head = (type: string, layer: string) => out.push('0', type, '8', layer);
  const layerOf = (style: Style): string | null => {
    if (style.dash === '3 1') {
      return 'HIDDEN';
    }
    if (style.dash && style.dash !== 'none') {
      return /^(8 |1\.5 1 6)/.test(style.dash) ? 'CENTER' : null;
    }

    return style.width >= 0.4 ? 'VISIBLE' : 'THIN';
  };
  const line = (a: P, b: P, style: Style, layer: string) => {
    const segs: [P, P][] = style.clip ? clipToCircle(a, b, style.clip.c, style.clip.r) : [[a, b]];
    for (const [start, q] of segs) {
      const [P1, P2] = [flip(apply(style.m, start)), flip(apply(style.m, q))];
      if (Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) < 1e-6) {
        continue;
      }
      head('LINE', layer);
      out.push('10', formatNumber(P1[0]), '20', formatNumber(P1[1]), '30', '0', '11', formatNumber(P2[0]), '21', formatNumber(P2[1]), '31', '0');
    }
  };
  /** A circle's arc from angle a0 sweeping by `sweep` (SVG's angles, y down), or the whole circle. */
  const arc = (center: P, radius: number, a0: number, sweep: number, style: Style, layer: string) => {
    if (style.clip) {
      // Cut to a detail's circle: as short lines.
      const steps = Math.max(8, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 96));
      let prev: P = [center[0] + radius * Math.cos(a0), center[1] + radius * Math.sin(a0)];
      for (let i = 1; i <= steps; i++) {
        const t = a0 + (sweep * i) / steps;
        const q: P = [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)];
        line(prev, q, style, layer);
        prev = q;
      }

      return;
    }
    const centerOnPaper = flip(apply(style.m, center));
    const rot = Math.atan2(style.m[1], style.m[0]);
    if (Math.abs(Math.abs(sweep) - Math.PI * 2) < 1e-9) {
      head('CIRCLE', layer);
      out.push('10', formatNumber(centerOnPaper[0]), '20', formatNumber(centerOnPaper[1]), '30', '0', '40', formatNumber(radius));

      return;
    }
    // y flipped: SVG's angle t is -t; the DXF arc runs counter-clockwise.
    const s0 = -(a0 + rot);
    const s1 = -(a0 + sweep + rot);
    const [from, to] = sweep >= 0 ? [s1, s0] : [s0, s1];
    head('ARC', layer);
    out.push('10', formatNumber(centerOnPaper[0]), '20', formatNumber(centerOnPaper[1]), '30', '0', '40', formatNumber(radius), '50', formatNumber(deg(from)), '51', formatNumber(deg(to)));
  };
  const solid = (pts: P[], style: Style, layer: string) => {
    const q = pts.map(point => flip(apply(style.m, point)));
    const controls = [q[0], q[1], q[q.length - 1], q.length > 3 ? q[2] : q[q.length - 1]];
    head('SOLID', layer);
    out.push('10', formatNumber(controls[0][0]), '20', formatNumber(controls[0][1]), '30', '0', '11', formatNumber(controls[1][0]), '21', formatNumber(controls[1][1]), '31', '0', '12', formatNumber(controls[2][0]), '22', formatNumber(controls[2][1]), '32', '0', '13', formatNumber(controls[3][0]), '23', formatNumber(controls[3][1]), '33', '0');
  };
  /** Hatch lines inside the loops (even-odd), every 2.5 mm at `angle` degrees from the vertical, as the sheet's pattern. */
  const hatchLines = (loops: P[][], angle: number, style: Style) => {
    const radians = (angle * Math.PI) / 180;
    // In the pattern's own frame the lines are x = 2.5k.
    const toPat = (point: P): P => [point[0] * Math.cos(radians) + point[1] * Math.sin(radians), -point[0] * Math.sin(radians) + point[1] * Math.cos(radians)];
    const fromPat = (point: P): P => [point[0] * Math.cos(radians) - point[1] * Math.sin(radians), point[0] * Math.sin(radians) + point[1] * Math.cos(radians)];
    const edges: [P, P][] = [];
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        edges.push([toPat(loop[i]), toPat(loop[(i + 1) % loop.length])]);
      }
    }
    if (!edges.length) {
      return;
    }
    const xs = edges.flatMap(([a, b]) => [a[0], b[0]]);
    for (let stripe = Math.ceil(Math.min(...xs) / 2.5); stripe * 2.5 <= Math.max(...xs); stripe++) {
      const x = stripe * 2.5;
      const ys: number[] = [];
      for (const [a, b] of edges) {
        if (a[0] <= x !== b[0] <= x) {
          ys.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
        }
      }
      ys.sort((lower, q) => lower - q);
      for (let i = 0; i + 1 < ys.length; i += 2) {
        line(fromPat([x, ys[i]]), fromPat([x, ys[i + 1]]), style, 'THIN');
      }
    }
  };
  const pathOf = (pathData: string, style: Style) => {
    const layer = style.hatch === undefined ? layerOf(style) : 'THIN';
    const filled = style.fill !== 'none' && style.fill !== 'transparent' && !style.fill.startsWith('url(');
    const stroked = style.stroke !== 'none';
    if (!layer || (!stroked && !filled && style.hatch === undefined)) {
      return;
    }
    const loops: P[][] = [];
    let cur: P = [0, 0];
    let start: P = [0, 0];
    let loop: P[] = [];
    const toks = pathData.match(/[MLHVAZmlhvaz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
    let i = 0;
    let cmd = '';
    const num = () => Number(toks[i++]);
    const close = () => {
      if (loop.length > 1) {
        loops.push(loop);
      }
      loop = [];
    };
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) {
        cmd = toks[i++];
      }
      const command = cmd.toUpperCase();
      if (command === 'Z') {
        if (stroked && style.hatch === undefined) {
          line(cur, start, style, layer);
        }
        cur = start;
        close();
        continue;
      }
      if (command === 'M') {
        close();
        cur = start = [num(), num()];
        loop = [cur];
        cmd = cmd === 'm' ? 'l' : 'L';
        continue;
      }
      let next: P;
      if (command === 'L') {
        next = [num(), num()];
      } else if (command === 'H') {
        next = [num(), cur[1]];
      } else if (command === 'V') {
        next = [cur[0], num()];
      } else if (command === 'A') {
        const rx = num();
        num();
        num();
        const large = num();
        const sweepF = num();
        next = [num(), num()];
        // The circle through cur and next (SVG's endpoint form, rx = ry).
        const dx = (cur[0] - next[0]) / 2;
        const dy = (cur[1] - next[1]) / 2;
        const radius = Math.max(rx, Math.hypot(dx, dy));
        const offset = Math.sqrt(Math.max(0, radius * radius - dx * dx - dy * dy)) / Math.hypot(dx, dy || 1e-30);
        const sg = large === sweepF ? 1 : -1;
        const center: P = [(cur[0] + next[0]) / 2 + sg * offset * -dy, (cur[1] + next[1]) / 2 + sg * offset * dx];
        const a0 = Math.atan2(cur[1] - center[1], cur[0] - center[0]);
        let sw = Math.atan2(next[1] - center[1], next[0] - center[0]) - a0;
        if (sweepF && sw < 0) {
          sw += Math.PI * 2;
        }
        if (!sweepF && sw > 0) {
          sw -= Math.PI * 2;
        }
        if (stroked && style.hatch === undefined) {
          arc(center, radius, a0, sw, style, layer);
        }
        for (let step = 1; step <= 12; step++) {
          loop.push([center[0] + radius * Math.cos(a0 + (sw * step) / 12), center[1] + radius * Math.sin(a0 + (sw * step) / 12)]);
        }
        cur = next;
        continue;
      } else {
        i++;
        continue;
      }
      if (stroked && style.hatch === undefined) {
        line(cur, next, style, layer);
      }
      loop.push(next);
      cur = next;
    }
    close();
    if (style.hatch !== undefined) {
      return hatchLines(loops, style.hatch, style);
    }
    // A small filled shape, no outline (an arrowhead): a solid.
    if (filled && !stroked) {
      for (const loop of loops) {
        if (loop.length >= 3 && loop.length <= 4) {
          solid(loop, style, 'THIN');
        }
      }
    }
  };

  // ---- Walk the elements, styles and transforms handed down through groups.
  const clips = new Map<string, { c: P; r: number }>();
  for (const [, id, body] of svg.matchAll(/<clipPath id="([^"]+)">(.*?)<\/clipPath>/gs)) {
    const match = /<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)"/.exec(body);
    if (match) {
      clips.set(id, { c: [Number(match[1]), Number(match[2])], r: Number(match[3]) });
    }
  }
  const hatches = new Map<string, number>();
  for (const [, id, a] of svg.matchAll(/<pattern id="([^"]+)"[^>]*patternTransform="rotate\(([-\d.]+)\)"/g)) {
    hatches.set(id, Number(a));
  }
  const body = svg.replace(/<defs>.*?<\/defs>/gs, '').replace(/<clipPath[^>]*>.*?<\/clipPath>/gs, '').replace(/<pattern[^>]*>.*?<\/pattern>/gs, '');
  const stack: Style[] = [{ stroke: 'none', width: 0.25, dash: '', fill: '#000', m: ID }];
  const attrs = (text: string) => Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
  const styled = (a: Record<string, string>, up: Style): Style => {
    const style: Style = {
      stroke: a.stroke ?? up.stroke,
      width: a['stroke-width'] !== undefined ? Number(a['stroke-width']) : up.width,
      dash: a['stroke-dasharray'] ?? up.dash,
      fill: a.fill ?? up.fill,
      m: a.transform ? mul(up.m, transformOf(a.transform)) : up.m,
      clip: up.clip,
      hatch: up.hatch
    };
    const cp = /url\(#([^)]+)\)/.exec(a['clip-path'] ?? '')?.[1];
    if (cp && clips.has(cp)) {
      style.clip = clips.get(cp);
    }
    const hp = /url\(#([^)]+)\)/.exec(a.fill ?? '')?.[1];
    style.hatch = hp && hatches.has(hp) ? hatches.get(hp) : undefined;

    return style;
  };
  const tagRe = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/g;
  let textOf: { a: Record<string, string>; s: Style; t: string } | null = null;
  for (const match of body.matchAll(tagRe)) {
    const [, closing, tag, rest, self, txt] = match;
    if (txt !== undefined) {
      if (textOf) {
        textOf.t += txt;
      }
      continue;
    }
    if (closing) {
      if (tag === 'g') {
        stack.length > 1 && stack.pop();
      }
      if (tag === 'text' && textOf) {
        const { a, s, t } = textOf;
        textOf = null;
        const str = unescape(t).trim();
        if (!str) {
          continue;
        }
        const point = flip(apply(s.m, [Number(a.x ?? 0), Number(a.y ?? 0)]));
        const size = Number(a['font-size'] ?? 3.5);
        const rot = -deg(Math.atan2(s.m[1], s.m[0]));
        const just = a['text-anchor'] === 'middle' ? 1 : a['text-anchor'] === 'end' ? 2 : 0;
        head('TEXT', 'TEXT');
        out.push('10', formatNumber(point[0]), '20', formatNumber(point[1]), '30', '0', '40', formatNumber(size * 0.7), '1', dxfText(str), '50', formatNumber(((rot % 360) + 360) % 360));
        if (just) {
          out.push('72', String(just), '11', formatNumber(point[0]), '21', formatNumber(point[1]), '31', '0');
        }
      }
      continue;
    }
    const a = attrs(rest);
    const up = stack[stack.length - 1];
    if (tag === 'g') {
      const style = styled(a, up);
      if (!self) {
        stack.push(style);
      }
      continue;
    }
    if (tag === 'text') {
      textOf = { a, s: styled(a, up), t: '' };
      continue;
    }
    const lineStyle = styled(a, up);
    if (tag === 'path' && a.d) {
      pathOf(a.d, lineStyle);
    } else if (tag === 'line') {
      pathOf(`M${a.x1} ${a.y1}L${a.x2} ${a.y2}`, lineStyle);
    } else if (tag === 'rect' && lineStyle.stroke !== 'none') {
      const [x, y, rectWidth, rectHeight] = [Number(a.x ?? 0), Number(a.y ?? 0), Number(a.width), Number(a.height)];
      pathOf(`M${x} ${y}L${x + rectWidth} ${y}L${x + rectWidth} ${y + rectHeight}L${x} ${y + rectHeight}Z`, { ...lineStyle, fill: 'none' });
    } else if (tag === 'circle') {
      const layer = layerOf(lineStyle);
      const filled = lineStyle.fill !== 'none' && lineStyle.fill !== 'transparent' && lineStyle.fill !== '#fff';
      if (layer && (lineStyle.stroke !== 'none' || filled)) {
        arc([Number(a.cx), Number(a.cy)], Number(a.r), 0, Math.PI * 2, lineStyle, lineStyle.stroke !== 'none' ? layer : 'THIN');
      }
    }
  }

  const ltype = (name: string, desc: string, parts: number[]) => ['0', 'LTYPE', '2', name, '70', '0', '3', desc, '72', '65', '73', String(parts.length), '40', formatNumber(parts.reduce((x, y) => x + Math.abs(y), 0)), ...parts.flatMap(part => ['49', formatNumber(part)])];
  const layer = (name: string, color: number, lt: string) => ['0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', lt];

  return [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4',
    '9', '$MEASUREMENT', '70', '1',
    '9', '$EXTMIN', '10', formatNumber(vb[0]), '20', '0', '30', '0',
    '9', '$EXTMAX', '10', formatNumber(vb[0] + vb[2]), '20', formatNumber(height), '30', '0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LTYPE', '70', '3',
    ...ltype('CONTINUOUS', 'Solid line', []),
    ...ltype('DASHED', 'Dashed __ __ __', [3, -1]),
    ...ltype('CENTER', 'Center ____ _ ____', [8, -1.5, 1.5, -1.5]),
    '0', 'ENDTAB',
    '0', 'TABLE', '2', 'LAYER', '70', '6',
    ...layer('0', 7, 'CONTINUOUS'),
    ...layer('VISIBLE', 7, 'CONTINUOUS'),
    ...layer('THIN', 8, 'CONTINUOUS'),
    ...layer('HIDDEN', 8, 'DASHED'),
    ...layer('CENTER', 1, 'CENTER'),
    ...layer('TEXT', 7, 'CONTINUOUS'),
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...out,
    '0', 'ENDSEC',
    '0', 'EOF',
    ''
  ].join('\n');
}
