// Run: npx tsx tests/svgexport.test.ts
// A sketch saved as SVG (File › Export SVG) and read back in (Insert › File): the same drawing, the same size.
import { parseSVG, sketchToSVG } from '../src/io/svg';
import { entityPolylines } from '../src/sketch/curves';
import type { SketchEntity, Vec2 } from '../src/doc/types';

let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const box = (es: SketchEntity[]) => {
  const pts = es.flatMap(e => entityPolylines(e).flat()) as Vec2[];

  return [Math.min(...pts.map(point => point[0])), Math.min(...pts.map(point => point[1])), Math.max(...pts.map(point => point[0])), Math.max(...pts.map(point => point[1]))];
};
const length = (es: SketchEntity[]) => es.reduce((total, e) => total + entityPolylines(e).reduce((t, poly) => t + poly.slice(1).reduce((sum, point, i) => sum + Math.hypot(point[0] - poly[i][0], point[1] - poly[i][1]), 0), 0), 0);

const sketch: SketchEntity[] = [
  { id: 'l', kind: 'line', a: [0, 0], b: [40, 0] },
  { id: 'a', kind: 'arc', a: [40, 0], m: [50, 10], b: [40, 20] },
  { id: 'big', kind: 'arc', a: [-10, 0], m: [-25, 15], b: [-10, 5] },
  { id: 'c', kind: 'circle', center: [20, 30], radius: 7.5 },
  { id: 'e', kind: 'ellipse', center: [-20, -20], rx: 12, ry: 5, rotation: 0.4 },
  { id: 'r', kind: 'rect', center: [60, -20], w: 20, h: 10, rotation: 0.3 },
  { id: 'p', kind: 'polygon', center: [0, 50], radius: 8, sides: 6, angle: 0.2 },
  { id: 's', kind: 'spline', points: [[70, 20], [80, 35], [95, 25], [100, 40]], closed: false, mode: 'fit' },
  { id: 'k', kind: 'line', a: [0, -40], b: [30, -45], construction: true } as SketchEntity
];
const svg = sketchToSVG(sketch, 'Bracket <1> & co');
check('it is an SVG in millimetres, with a title', /^<\?xml/.test(svg) && /width="[\d.]+mm"/.test(svg) && svg.includes('<title>Bracket 1  co</title>'));
check('a circle is a circle, an arc an arc', svg.includes('<circle ') && (svg.match(/ A/g) ?? []).length === 2);
check('construction curves are apart, dashed', /<g id="construction"[^>]*stroke-dasharray/.test(svg));
const back = parseSVG(svg).entities;
const [b0, b1] = [box(sketch), box(back)];
// (Read back, y runs the page's way: its height and width are what count, and what is drawn.)
check('read back: as wide and as tall', Math.abs(b0[2] - b0[0] - (b1[2] - b1[0])) < 0.05 && Math.abs(b0[3] - b0[1] - (b1[3] - b1[1])) < 0.05, `${b0.map(value => value.toFixed(2))} / ${b1.map(value => value.toFixed(2))}`);
check('read back: the same length of line drawn', Math.abs(length(sketch) - length(back)) < length(sketch) * 0.002, `${length(sketch).toFixed(2)} / ${length(back).toFixed(2)}`);
check('nothing drawn: still a file', /^<\?xml/.test(sketchToSVG([])) && !sketchToSVG([]).includes('NaN') && !sketchToSVG([]).includes('Infinity'));
process.exit(failed ? 1 : 0);
