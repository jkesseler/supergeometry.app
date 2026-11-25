// Insert menu: files (STEP/STL/OBJ/DXF/projects), images, variables.

import { newId, parseProject } from '../doc/store';
import { GROUND } from '../geom';
import { uid } from '../sketch/edit';
import { bareExpr, evaluate, fmtLen, RESERVED, setVariables, withUnitOf } from '../units';
import { namesIn } from '../doc/varAnchors';
import { nameProblem, renameVariable } from '../doc/renameVariable';
import { DIALOG_ACTION } from '../ui/dialogAction';
import { read3mf } from './formats';
import { parseSVG } from './svg';
import type { AppContext } from '../tools/tool';
import type { Feature, ImageFeature, PlaneDef, SketchEntity, SketchFeature } from '../doc/types';

/**
 * What a file picker is told to offer. On an iPad or iPhone, nothing: told a list of endings (".stl,.step,.super"),
 * the Files window there greys out every file whose kind it has no name for - STL and STEP files and the app's own
 * projects could not be tapped (reported from an iPad, files in iCloud Drive). Every file can be picked there, and
 * one that is not of a kind the app reads is said so once picked. (A list of kinds alone, "image/*", is understood.)
 */
export function acceptFor(accept: string): string {
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

  return apple && accept.split(',').some(a => a.trim().startsWith('.')) ? '' : accept;
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptFor(accept);
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Why a mesh / STEP file can't be what it says (null: it looks right). */
function unreadable(bytes: Uint8Array, format: 'step' | 'stl'): string | null {
  if (format === 'step') {
    const head = new TextDecoder().decode(bytes.subarray(0, 4096));
    if (!/ISO-10303-21/.test(head)) {
      return "it isn't a STEP file";
    }
    if (!new TextDecoder().decode(bytes).includes('DATA;')) {
      return 'the file is damaged (it has no shapes in it)';
    }

    return null;
  }
  // Binary STL: 80 bytes, a triangle count, 50 bytes per triangle.
  if (bytes.length >= 84) {
    const triangleCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (triangleCount > 0 && 84 + triangleCount * 50 === bytes.length) {
      return null;
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (/\bfacet\b/i.test(text) && /\bvertex\b/i.test(text)) {
    return null;
  }

  return bytes.length ? "it isn't an STL file, or it is damaged" : 'the file is empty';
}

/**
 * A mesh has come in (or was asked to be given faces): once it is built, how many of its round parts are true
 * round faces now, said once. (Looked for a few times a second until the body is there - it can take a while.)
 */
export function sayRounds(app: AppContext, id: string, name: string, before = -1): void {
  const began = Date.now();
  const look = () => {
    if (!app.store.doc.features.some(f => f.id === id)) {
      return;
    }
    const body = app.view.body(id);
    const count = body ? body.faces.filter(f => f.round).length : -1;
    // (Asked of a mesh already in the project: until its faces have changed.)
    if (body && (before < 0 || body.faces.length !== before)) {
      if (count > 0) {
        app.ui.toast(`${name}: ${count} round ${count === 1 ? 'part is a true round face' : 'parts are true round faces'} now (holes, bosses, rounded corners).`);
      }

      return;
    }
    if (Date.now() - began < 180_000) {
      setTimeout(look, 400);
    }
  };
  setTimeout(look, 400);
}

export async function insertFile(app: AppContext): Promise<void> {
  const file = await pickFile('.step,.stp,.stl,.obj,.3mf,.dxf,.svg,.dwg,.super,.tessel');
  if (!file) {
    return;
  }
  const ext = file.name.split('.').pop()!.toLowerCase();
  try {
    if (ext === 'dwg') {
      app.ui.toast('DWG is a closed format. Save it as DXF (e.g. with LibreCAD or ODA File Converter, both free) and insert that.', 'error');

      return;
    }
    if (ext === 'dxf') {
      const entities = parseDXF(await file.text());
      if (!entities.length) {
        throw new Error('No lines, arcs, circles, polylines or splines found');
      }
      const sk: SketchFeature = { ...app.store.newIdentity('sketch', file.name.replace(/\.dxf$/i, '')), type: 'sketch', plane: GROUND, entities };
      app.store.add(sk);
      app.ui.toast(`Inserted ${entities.length} curves as a sketch on the ground plane`);

      return;
    }
    if (ext === 'svg') {
      // Outlines (logos, laser/vinyl cut files…) as a sketch, centred on the origin.
      const { entities, size } = parseSVG(await file.text());
      const sk: SketchFeature = { ...app.store.newIdentity('sketch', file.name.replace(/\.svg$/i, '')), type: 'sketch', plane: GROUND, entities };
      app.store.add(sk);
      app.ui.toast(`Inserted ${entities.length} curves (${fmtLen(size[0])} × ${fmtLen(size[1])}) as a sketch on the ground plane`);

      return;
    }
    if (ext === 'super' || ext === 'tessel') {
      insertProject(app, parseProject(await file.text()).features, file.name);

      return;
    }
    // (Any file can be picked on an iPad: see acceptFor.)
    if (!['step', 'stp', 'stl', 'obj', '3mf'].includes(ext)) {
      return app.ui.toast(`Could not insert ${file.name}: it is not a kind of file the app reads (STEP, STL, OBJ, 3MF, DXF, SVG or a project)`, 'error');
    }
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    let format: 'step' | 'stl' = ext === 'stl' ? 'stl' : 'step';
    if (ext === 'obj') {
      bytes = objToStl(new TextDecoder().decode(bytes));
      format = 'stl';
    }
    // 3MF: the exact model packed in it (ours), else its meshes.
    if (ext === '3mf') {
      ({ format, bytes } = await read3mf(bytes));
    }
    // A damaged or wrong file stops here, not as a failed step in History
    // (that kept the broken file in the project).
    const why = unreadable(bytes, format);
    if (why) {
      return app.ui.toast(`Could not insert ${file.name}: ${why}`, 'error');
    }
    app.ui.setStatus(`Importing ${file.name}…`);
    // (A mesh: its flat faces made whole and its round parts round - see kernel/meshRound.ts.)
    const step = { ...app.store.newIdentity('import'), type: 'import' as const, format, fileName: file.name, data: toBase64(bytes), apart: true, ...(format === 'stl' ? { round: true } : {}) };
    app.store.add(step);
    if (format === 'stl') {
      sayRounds(app, step.id, file.name);
    }
    app.ui.setStatus(null);
  } catch (err) {
    app.ui.setStatus(null);
    app.ui.toast(`Could not insert ${file.name}: ${(err as Error).message}`, 'error');
  }
}

/** Append another project's history (ids are renamed so nothing collides). */
function insertProject(app: AppContext, features: Feature[], name: string): void {
  const map = new Map(features.map(feature => [feature.id, newId(feature.type)]));
  let json = JSON.stringify(features);
  for (const [from, to] of map) {
    json = json.split(`"${from}"`).join(`"${to}"`);
  }
  const renamed = JSON.parse(json) as Feature[];
  app.store.commit(draft => draft.features.push(...renamed));
  app.ui.toast(`Inserted ${renamed.length} steps from ${name}`);
}

export async function insertImage(app: AppContext, plane: PlaneDef = GROUND): Promise<ImageFeature | null> {
  const file = await pickFile('image/*');
  if (!file) {
    return null;
  }
  let src = await new Promise<string>((resolve) => {
    const fileReader = new FileReader();
    fileReader.onload = () => resolve(fileReader.result as string);
    fileReader.readAsDataURL(file);
  });
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    app.ui.toast(`${file.name} can't be shown here - save it as JPG or PNG first (an iPhone's HEIC photos too)`, 'error');

    return null;
  }
  // A phone photo (4000 px, 12 MB) kept whole went into the project and was
  // saved again on every change, and wider than a phone can draw (4096 px):
  // 2048 px across is plenty to trace over.
  const MAX = 2048;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  if (scale < 1 || file.size > 2e6) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    // PNG keeps see-through parts (a logo); a photo is smaller as JPEG.
    src = file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
  }
  const width = 100;
  const image: ImageFeature = { ...app.store.newIdentity('image'), type: 'image', plane, src, width, height: (width * img.height) / img.width, opacity: 0.8 };
  app.store.add(image);
  app.ui.toast('Image placed on the floor, 100 mm wide: stand it up, place and size it here');

  return image;
}

/**
 * Create a named variable (optionally from a field's current value); returns
 * its name. "Add Another" at the top makes it and opens a fresh one (a window
 * needs twenty: the dialog had to be reopened from the card each time) - the
 * name returned is still the first one's, the one made from the field's value.
 */
export async function createVariable(app: AppContext, value = ''): Promise<string | null> {
  let first: string | null = null;
  let name = '';
  for (;;) {
    const one = await createOne(app, name, value);
    first ??= one.made;
    // A bad name or value: the next window has what was typed, to put right (after OK too: the window closed, and
    // what was typed was gone).
    const again = !one.made && !!(one.typed.name.trim() || one.typed.expr.trim());
    if (!one.another && !again) {
      return first;
    }
    [name, value] = one.made ? ['', ''] : [one.typed.name, one.typed.expr];
  }
}

async function createOne(app: AppContext, name: string, value: string): Promise<{ made: string | null; another: boolean; typed: { name: string; expr: string } }> {
  const list = app.store.doc.variables;
  const note = list.length ? `Existing: ${list.map(variable => `${variable.name} = ${variable.expr}`).join(', ')}` : 'Use variables in any field, e.g. width*2 or wall + 1mm.';
  const answers = await app.ui.dialog('Create Variable', [
    { key: 'name', label: 'Name', value: name, placeholder: 'width' },
    { key: 'expr', label: 'Value', value, placeholder: '40 or 1.5in or depth/2' }
  ], note, { label: 'Add Another', icon: 'variableNew' });
  if (!answers) {
    return { made: null, another: false, typed: { name: '', expr: '' } };
  }

  return { made: makeVariable(app, list, answers), another: !!answers[DIALOG_ACTION], typed: { name: answers.name, expr: answers.expr } };
}

function makeVariable(app: AppContext, list: AppContext['store']['doc']['variables'], answers: Record<string, string>): string | null {
  const name = answers.name.trim();
  // (A variable called sin or pi hid the function: sin(30) stopped working.)
  if (!/^[a-z_][a-z0-9_]*$/i.test(name) || RESERVED.test(name)) {
    app.ui.toast('Names use letters, digits and _ (not starting with a digit, and not a unit or a function like sin or pi)', 'error');

    return null;
  }
  // (od and Od would be two variables, and one typed for the other is a wrong size with nothing said.)
  const twin = list.find(variable => variable.name !== name && variable.name.toLowerCase() === name.toLowerCase());
  if (twin) {
    app.ui.toast(`There is a variable ${twin.name} already: ${name} differs only in its capitals`, 'error');

    return null;
  }
  const was = list.find(variable => variable.name === name);
  const next = [...list.filter(variable => variable.name !== name), { name, expr: answers.expr.trim() || '0' }];
  setVariables(next);
  // (An angle - "30 deg" - is a value too: it was refused here, and taken in the list of them all.)
  if (evaluate(answers.expr || '0') === null && evaluate(answers.expr || '0', 'angle') === null) {
    setVariables(list);
    const unknown = namesIn(answers.expr).filter(used => used !== name && !next.some(variable => variable.name === used) && !RESERVED.test(used));
    app.ui.toast(
      new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`).test(answers.expr)
        ? `${name} can't use itself`
        : unknown.length
          ? `${unknown.join(', ')}: no variable has that name`
          : `"${answers.expr}" isn't a valid value`,
      'error'
    );

    return null;
  }
  app.store.commit(draft => (draft.variables = next));
  // (One there already by that name is changed, and said so.)
  app.ui.toast(was && was.expr !== answers.expr.trim() ? `${name} changed: ${was.expr} → ${answers.expr.trim()}` : `${name} = ${answers.expr}`);

  return name;
}

/**
 * The Variables window: every variable at once (changing one rebuilds everything
 * that uses it), and New Variable at its top. Making one keeps what was typed,
 * then comes back here with the new one in the list.
 */
export async function editVariables(app: AppContext): Promise<void> {
  for (;;) {
    const list = app.store.doc.variables;
    const answers = await app.ui.dialog(
      'Variables',
      list.map(variable => ({ key: variable.name, label: variable.name, value: bareExpr(variable.expr) })),
      list.length
        ? 'Change a value to update every feature that uses it. Clear a value to delete the variable.'
        : 'No variables yet. Make one, then use it in any field, e.g. width*2 or wall + 1mm.',
      { label: 'New Variable', icon: 'variableNew' }
    );
    if (!answers) {
      return;
    }
    if (list.length) {
      // Shown without the unit in use ("220"): a plain number keeps the unit it had.
      const next = list.filter(variable => answers[variable.name]?.trim()).map(variable => ({ name: variable.name, expr: withUnitOf(answers[variable.name], variable.expr) }));
      setVariables(next);
      // (An angle - "30 deg" - is a value too: it was refused as a length.)
      const bad = next.find(variable => evaluate(variable.expr) === null && evaluate(variable.expr, 'angle') === null);
      if (bad) {
        setVariables(list);
        // (Said as it is: another variable still uses the one being deleted.)
        const lost = list.filter(variable => !next.some(nextVariable => nextVariable.name === variable.name)).find(variable => new RegExp(`(^|[^A-Za-z0-9_])${variable.name}($|[^A-Za-z0-9_])`).test(bad.expr));

        return app.ui.toast(lost ? `${bad.name} uses ${lost.name} (${bad.name} = ${bad.expr}): change ${bad.name} first` : `"${bad.expr}" isn't a valid value for ${bad.name}`, 'error');
      }
      // Deleted while steps still use it: they keep the sizes they have now, as
      // plain numbers (else every rebuild said "can't be evaluated").
      const gone = list.filter(variable => !next.some(nextVariable => nextVariable.name === variable.name)).map(variable => variable.name);
      // (Capitals count: W deleted is not w deleted.)
      const uses = (expr: string) => gone.some(name => new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`).test(expr));
      let kept = 0;
      if (next.some((variable, i) => variable.name !== list[i]?.name || variable.expr !== list[i]?.expr) || next.length !== list.length) {
        app.store.commit((draft) => {
          draft.variables = next;
          for (const feature of draft.features) {
            for (const [path, expr] of Object.entries(feature.exprs ?? {})) {
              if (uses(expr)) {
                (delete feature.exprs![path], kept++);
              }
            }
            // (A sketch pattern that followed it: its copies stay as they are, plain curves from now on.)
            if (feature.type === 'sketch' && feature.repeats?.some(repeat => uses(repeat.countExpr))) {
              kept += feature.repeats.filter(repeat => uses(repeat.countExpr)).length;
              feature.repeats = feature.repeats.filter(repeat => !uses(repeat.countExpr));
              if (!feature.repeats.length) {
                delete feature.repeats;
              }
            }
            if (feature.type === 'sketch') {
              for (const sketchConstraint of feature.constraints ?? []) {
                if (sketchConstraint.expr && uses(sketchConstraint.expr)) {
                  (delete sketchConstraint.expr, kept++);
                }
                // (A point placed by it too: left, every rebuild said it can't be evaluated.)
                if (sketchConstraint.atExpr?.some(e => e && uses(e))) {
                  sketchConstraint.atExpr = sketchConstraint.atExpr.map(e => (e && uses(e) ? null : e));
                  if (!sketchConstraint.atExpr.some(e => e)) {
                    delete sketchConstraint.atExpr;
                  }
                  kept++;
                }
              }
            }
          }
        });
      }
      if (kept) {
        app.ui.toast(`${gone.join(', ')} deleted - the ${kept === 1 ? 'size' : `${kept} sizes`} that used ${gone.length > 1 ? 'them' : 'it'} ${kept === 1 ? 'keeps its value' : 'keep their values'}`);
      }
    }
    if (!answers[DIALOG_ACTION]) {
      return;
    }
    await createVariable(app);
  }
}

/**
 * Rename Variables: each variable's name in a box, to change. Everything that uses a renamed variable - other
 * variables, steps' sizes, sketch dimensions - says its new name; nothing changes size. (A variable could only be
 * deleted and made again under another name, and what used it lost its link to it.)
 */
export async function renameVariables(app: AppContext): Promise<void> {
  const list = app.store.doc.variables;
  if (!list.length) {
    return;
  }
  const answers = await app.ui.dialog(
    'Rename Variables',
    list.map(variable => ({ key: variable.name, label: `${variable.name} =  ${bareExpr(variable.expr)}`, value: variable.name })),
    'Type a new name over an old one. Everything that uses it follows, and nothing changes size.'
  );
  if (!answers) {
    return;
  }
  const wanted = list.map(variable => ({ from: variable.name, to: (answers[variable.name] ?? variable.name).trim() || variable.name })).filter(rename => rename.from !== rename.to);
  if (!wanted.length) {
    return;
  }
  // Tried on a copy first: all of them, or none (two swapping names go by way of a spare one).
  const trial = structuredClone(app.store.doc);
  const spare = (i: number) => `__renaming_${i}__`;
  wanted.forEach((rename, i) => renameVariable(trial, rename.from, spare(i)));
  for (const [i, rename] of wanted.entries()) {
    const problem = nameProblem(trial, spare(i), rename.to);
    if (problem) {
      return app.ui.toast(`${rename.from} → ${rename.to}: ${problem}`, 'error');
    }
    renameVariable(trial, spare(i), rename.to);
  }
  app.store.commit((draft) => {
    draft.variables = trial.variables;
    draft.features = trial.features;
  });
  app.ui.toast(wanted.length === 1 ? `${wanted[0].from} is ${wanted[0].to} now, everywhere it is used` : `${wanted.length} variables renamed, everywhere they are used`);
}

// -------------------------------------------------------------------- DXF

/** Minimal ASCII DXF reader: LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE, SPLINE, ELLIPSE. */
export function parseDXF(text: string): SketchEntity[] {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  }
  const start = pairs.findIndex((pair, i) => pair[0] === 2 && pair[1] === 'ENTITIES' && pairs[i - 1]?.[1] === 'SECTION');
  if (start < 0) {
    return [];
  }
  const out: SketchEntity[] = [];
  let i = start + 1;
  const num = (codes: [number, string][], code: number, fallback = 0) => Number(codes.find(entry => entry[0] === code)?.[1] ?? fallback);
  while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC')) {
    if (pairs[i][0] !== 0) {
      i++;
      continue;
    }
    const type = pairs[i][1];
    const codes: [number, string][] = [];
    i++;
    while (i < pairs.length && pairs[i][0] !== 0) {
      codes.push(pairs[i++]);
    }
    if (type === 'LINE') {
      out.push({ id: uid(), kind: 'line', a: [num(codes, 10), num(codes, 20)], b: [num(codes, 11), num(codes, 21)] });
    } else if (type === 'CIRCLE') {
      out.push({ id: uid(), kind: 'circle', center: [num(codes, 10), num(codes, 20)], radius: num(codes, 40) });
    } else if (type === 'ARC') {
      const center: [number, number] = [num(codes, 10), num(codes, 20)];
      const radius = num(codes, 40);
      const a0 = (num(codes, 50) * Math.PI) / 180;
      let a1 = (num(codes, 51) * Math.PI) / 180;
      if (a1 <= a0) {
        a1 += Math.PI * 2;
      }
      const at = (t: number): [number, number] => [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)];
      out.push({ id: uid(), kind: 'arc', a: at(a0), m: at((a0 + a1) / 2), b: at(a1) });
    } else if (type === 'ELLIPSE') {
      const mx = num(codes, 11);
      const my = num(codes, 21);
      const rx = Math.hypot(mx, my);
      out.push({ id: uid(), kind: 'ellipse', center: [num(codes, 10), num(codes, 20)], rx, ry: rx * num(codes, 40, 1), rotation: Math.atan2(my, mx) });
    } else if (type === 'LWPOLYLINE') {
      const xs = codes.filter(code => code[0] === 10).map(code => Number(code[1]));
      const ys = codes.filter(code => code[0] === 20).map(code => Number(code[1]));
      const closed = (num(codes, 70) & 1) === 1;
      const pts = xs.map((x, index) => [x, ys[index]] as [number, number]);
      if (pts.length >= 2) {
        out.push({ id: uid(), kind: 'polyline', points: pts, closed });
      }
    } else if (type === 'SPLINE') {
      const fx = codes.filter(code => code[0] === 11).map(code => Number(code[1]));
      const fy = codes.filter(code => code[0] === 21).map(code => Number(code[1]));
      const cx = codes.filter(code => code[0] === 10).map(code => Number(code[1]));
      const cy = codes.filter(code => code[0] === 20).map(code => Number(code[1]));
      const closed = (num(codes, 70) & 1) === 1;
      if (fx.length >= 2) {
        out.push({ id: uid(), kind: 'spline', points: fx.map((x, index) => [x, fy[index]]), closed, mode: 'fit' });
      } else if (cx.length >= 2) {
        out.push({ id: uid(), kind: 'spline', points: cx.map((x, index) => [x, cy[index]]), closed, mode: 'control' });
      }
    } else if (type === 'POLYLINE') {
      const closed = (num(codes, 70) & 1) === 1;
      const pts: [number, number][] = [];
      while (i < pairs.length && pairs[i][1] === 'VERTEX') {
        i++;
        const codes: [number, string][] = [];
        while (i < pairs.length && pairs[i][0] !== 0) {
          codes.push(pairs[i++]);
        }
        pts.push([num(codes, 10), num(codes, 20)]);
      }
      if (pts.length >= 2) {
        out.push({ id: uid(), kind: 'polyline', points: pts, closed });
      }
    }
  }

  // Only curves that make sense: real numbers, some size (a damaged file
  // mustn't put NaN or a dot into the sketch).
  return out.filter(usableCurve);
}

function usableCurve(e: SketchEntity): boolean {
  let finite = true;
  JSON.stringify(e, (_k, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      finite = false;
    }

    return value;
  });
  if (!finite) {
    return false;
  }
  switch (e.kind) {
    case 'line':
      return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) > 1e-9;
    case 'circle':
      return e.radius > 1e-9;
    case 'arc':
      return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) > 1e-9 || Math.hypot(e.m[0] - e.a[0], e.m[1] - e.a[1]) > 1e-9;
    case 'ellipse':
      return e.rx > 1e-9 && e.ry > 1e-9;
    case 'spline':
    case 'polyline':
      return e.points.length >= 2;
    default:
      return true;
  }
}

// -------------------------------------------------------------------- OBJ

/** OBJ (triangles/polygons) → binary STL, so the kernel can import it. */
export function objToStl(text: string): Uint8Array {
  const vertices: number[][] = [];
  const tris: number[][] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') {
      vertices.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (parts[0] === 'f') {
      // Points by number (from 1), or counted back from the last one (-1).
      const idx = parts.slice(1).map((token) => {
        const vertexNumber = parseInt(token.split('/')[0], 10);

        return vertexNumber < 0 ? vertices.length + vertexNumber : vertexNumber - 1;
      });
      // A face pointing at points that aren't there (or with broken numbers): skipped.
      const ok = (index: number) => Number.isInteger(index) && index >= 0 && index < vertices.length && vertices[index].every(Number.isFinite);
      if (idx.length < 3 || !idx.every(ok)) {
        skipped++;
        continue;
      }
      for (let index = 1; index + 1 < idx.length; index++) {
        tris.push([idx[0], idx[index], idx[index + 1]]);
      }
    }
  }
  if (!tris.length) {
    throw new Error(skipped ? "The OBJ file's faces use points that are missing or broken (a damaged file?)" : 'No faces in the OBJ file');
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let offset = 84;
  for (const t of tris) {
    offset += 12; // normal left as zero; readers recompute it
    for (const vertex of t) {
      for (let axis = 0; axis < 3; axis++) {
        dv.setFloat32(offset + axis * 4, vertices[vertex][axis], true);
      }
      offset += 12;
    }
    offset += 2;
  }

  return new Uint8Array(buf);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}
