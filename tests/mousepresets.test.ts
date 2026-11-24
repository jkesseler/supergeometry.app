// Run: npx tsx tests/mousepresets.test.ts
// Settings > Mouse: what each press does to the view in each program's way (as its own help gives it).
import { MOUSE_PRESETS, mouseChord, mouseDrag, mousePreset } from '../src/settings';

let failed = 0;
const check = (name: string, ok: boolean, info: unknown = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};
const keys = (held = '') => ({ shift: held.includes('s'), ctrl: held.includes('c'), alt: held.includes('a') });
/** "m" middle, "sm" Shift + middle, "cm", "csm", "r" right, "sr", "cr", "al" Alt + left, "l" left. */
const press = (id: string, what: string) => mouseDrag(id, what.endsWith('m') ? 1 : what.endsWith('r') ? 2 : 0, keys(what.slice(0, -1)));
const want: Record<string, Record<string, string | null>> = {
  default: { m: 'pan', sm: 'pan', r: 'right', sr: 'pan', cr: 'pan', al: 'orbit', l: null },
  fusion: { m: 'pan', sm: 'orbit', csm: 'zoom', r: 'right', al: 'orbit', l: null },
  solidworks: { m: 'orbit', cm: 'pan', sm: 'zoom', r: 'right', l: null },
  creo: { m: 'orbit', sm: 'pan', cm: 'zoom', r: 'right', l: null },
  nx: { m: 'orbit', sm: 'pan', cm: 'zoom', r: 'right', l: null },
  catia: { m: 'pan', cm: 'zoom', r: 'right', l: null },
  rhino: { r: 'right', sr: 'pan', cr: 'zoom', m: 'pan', l: null }
};
check('a preset for each way', MOUSE_PRESETS.map(mousePreset => mousePreset.id).sort().join() === Object.keys(want).sort().join(), MOUSE_PRESETS.map(mousePreset => mousePreset.id).join());
for (const [id, presses] of Object.entries(want)) {
  const got = Object.fromEntries(Object.keys(presses).map(pressName => [pressName, press(id, pressName)]));
  check(`${mousePreset(id).apps}: ${Object.entries(presses).map(([press, action]) => `${press} ${action}`).join(', ')}`, JSON.stringify(got) === JSON.stringify(presses), JSON.stringify(got) === JSON.stringify(presses) ? '' : JSON.stringify(got));
}
// Buttons held together (bit 1 left, 2 right, 4 middle).
check('NX: middle + right moves, middle + left zooms, middle alone nothing more', mouseChord('nx', 4 | 2) === 'pan' && mouseChord('nx', 4 | 1) === 'zoom' && mouseChord('nx', 4) === null);
check('CATIA, FreeCAD: middle + left or right turns', mouseChord('catia', 4 | 1) === 'orbit' && mouseChord('catia', 4 | 2) === 'orbit' && mouseChord('catia', 4) === null && mouseChord('catia', 2) === null);
check('the others have no buttons held together', ['default', 'fusion', 'solidworks', 'creo', 'rhino'].every(id => mouseChord(id, 7) === null));
check("a setting not known (an older one) is the app's own way", mousePreset('shiftMiddle').id === 'default' && press('whatever', 'm') === 'pan');
check('every preset says what it does, and names its programs', MOUSE_PRESETS.every(mousePreset => mousePreset.text.length > 20 && mousePreset.apps.length > 1));
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
