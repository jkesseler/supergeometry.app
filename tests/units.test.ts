// Run: npx tsx tests/units.test.ts - what a size field accepts.
import { evaluate, setUnits, setVariables } from '../src/units';

let failed = 0;
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;
function check(text: string, kind: 'length' | 'number' | 'angle', want: number | null): void {
  const got = evaluate(text, kind);
  const ok = want === null ? got === null : near(got, want);
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', `${kind} "${text}" = ${got} (want ${want})`);
}

setVariables([{ name: 'af', expr: '36 mm' }, { name: 'tilt', expr: '30 deg' }]);
check('36/sqrt(3)', 'length', 36 / Math.sqrt(3)); // a hex's corner radius from its size across the flats
check('af/sqrt(3)', 'length', 36 / Math.sqrt(3));
check('2^3', 'number', 8);
check('2^3^2', 'number', 512); // right to left
check('3*2^2', 'length', 12);
check('10*sin(30)', 'length', 5); // degrees
check('cos(60)', 'number', 0.5);
check('abs(-4)', 'length', 4);
check('2*pi', 'number', 2 * Math.PI);
check('1in + 1', 'length', 26.4);
check('sqrt 3', 'length', null); // needs its brackets
check('sqrt(3', 'length', null);
check('nope(3)', 'length', null);
check('5,5', 'length', 5.5); // a decimal comma
check('1,000', 'length', null); // one, or a thousand? not guessed
check('+5', 'length', 5);
check('5.', 'length', 5); // a dot typed, nothing after it yet
check('2^1000', 'length', null); // no size is that big
check('tilt', 'angle', 30); // a variable that is an angle, in an angle box
check('30°', 'angle', 30);
check('30 deg', 'length', null);

// More functions: whole numbers, the angle of a slope, the smaller and the larger of several.
check('floor(7.9)', 'number', 7);
check('ceil(7.1)', 'number', 8);
check('round(7.5)', 'number', 8);
check('floor(120 / 25)', 'number', 4); // how many 25s fit in 120
check('floor(0.3 * 10)', 'number', 3); // 2.9999999999999996 is 3
check('atan(1)', 'angle', 45);
check('asin(0.5)', 'angle', 30);
check('acos(0.5)', 'angle', 60);
check('min(3, 8, 5)', 'length', 3);
check('max(3; 8; 5)', 'length', 8);
check('max(1,5)', 'length', 5); // a comma parts the values here, it is no decimal comma
check('min(af, 20) / 2', 'length', 10);
check('min(3)', 'length', 3);
check('floor(3, 4)', 'length', null); // one value only

// A long chain of variables, each built on the one before: it stopped at eight deep.
setVariables(Array.from({ length: 40 }, (_, i) => ({ name: `v${i}`, expr: i ? `v${i - 1} + 1` : '1' })));
check('v39', 'length', 40);
check('v39 * 2 - v0', 'length', 79);
// Each used twice by the next, twenty deep: a million readings if each is read again every time.
setVariables(Array.from({ length: 30 }, (_, i) => ({ name: `d${i}`, expr: i ? `d${i - 1} / 2 + d${i - 1} / 2` : '8' })));
const t0 = performance.now();
check('d29', 'length', 8);
const took = performance.now() - t0;
if (took > 200) {
  failed++;
}
console.log(took > 200 ? 'FAIL' : 'ok  ', `thirty deep, each used twice: ${took.toFixed(1)} ms`);
// A circle of them is refused, not followed for ever.
setVariables([{ name: 'a', expr: 'b + 1' }, { name: 'b', expr: 'c * 2' }, { name: 'c', expr: 'a' }, { name: 'ok', expr: '5' }]);
check('a', 'length', null);
check('ok + 1', 'length', 6);
setVariables([{ name: 's', expr: 's' }]);
check('s', 'length', null);
// What it knows of one set of variables is not kept for the next.
setVariables([{ name: 'w', expr: '10' }]);
check('w * 2', 'length', 20);
setVariables([{ name: 'w', expr: '15' }]);
check('w * 2', 'length', 30);
// Units: a variable with its unit means the same whatever unit is in use; one without is in that unit.
setUnits('in');
setVariables([{ name: 'wall', expr: '2 mm' }, { name: 'n', expr: '4' }, { name: 'len', expr: '3' }]);
check('wall', 'length', 2);
check('wall * 2', 'length', 4);
check('2 * wall', 'length', 4);
check('len', 'length', 76.2);
check('len / 2', 'length', 38.1);
check('len * n', 'length', 304.8);
check('n', 'number', 4);
check('n + 1', 'number', 5);
check('sqrt(16)', 'length', 4 * 25.4);
check('max(1, 2)', 'length', 2 * 25.4);
setUnits('mm');
check('len', 'length', 3); // read again for the unit now in use

process.exit(failed ? 1 : 0);
