// Check a project from the command line: rebuild it step by step and say what
// each step did (its error, the bodies it made, changed or took away) and how
// sound each body is at the end.
//
//   npx tsx scripts/check.ts project.super            step by step, then the bodies
//   npx tsx scripts/check.ts project.super --end      only the bodies at the end
//   npx tsx scripts/check.ts project.super --json     the same, as JSON
//   npx tsx scripts/check.ts project.super --png a.png   and a picture of it (see render.ts)
//
// Exit code 1 when a step fails or a body isn't sound.
import { readFileSync } from 'node:fs';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { parseProject } from '../src/doc/store';
import { debugBodies, healthReport, regenerate } from '../src/kernel/engine';
import { renderPNG, type RenderOptions } from './render';
import type { BodyHealth } from '../src/kernel/protocol';
import type { Feature } from '../src/doc/types';

export interface StepReport {
  index: number;
  id: string;
  name: string;
  type: string;
  off?: boolean;
  error?: string;
  note?: string;
  /** Bodies it made, took away, or changed (volume before → after, mm³). */
  made: string[];
  gone: string[];
  changed: { body: string; from: number; to: number }[];
  /** Bodies that were sound before it and aren't after. */
  broke: string[];
  ms: number;
}

export interface CheckReport {
  name: string;
  steps?: StepReport[];
  bodies: BodyHealth[];
  errors: { step: string; message: string }[];
  ok: boolean;
}

/** Every body's health after the steps (name from the rebuild). */
function bodiesNow(names: Map<string, string>): BodyHealth[] {
  return [...debugBodies()].map(([id, shape]) => healthReport(id, names.get(id) ?? id, shape));
}

export async function checkProject(features: Feature[], name: string, stepwise = true): Promise<CheckReport> {
  const steps: StepReport[] = [];
  if (stepwise) {
    let before = new Map<string, BodyHealth>();
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      const t0 = performance.now();
      const result = await regenerate(features.slice(0, i + 1));
      const names = new Map(result.bodies.map(b => [b.id, b.name]));
      const now = new Map(bodiesNow(names).map(bodyHealth => [bodyHealth.id, bodyHealth]));
      const step: StepReport = { index: i + 1, id: feature.id, name: feature.name, type: feature.type, made: [], gone: [], changed: [], broke: [], ms: Math.round(performance.now() - t0) };
      if (feature.suppressed) {
        step.off = true;
      }
      const err = result.errors.find(e => e.featureId === feature.id);
      if (err) {
        step.error = err.message;
      }
      const note = result.notes?.find(e => e.featureId === feature.id);
      if (note) {
        step.note = note.message;
      }
      for (const [id, bodyHealth] of now) {
        const was = before.get(id);
        if (!was) {
          step.made.push(bodyHealth.name);
        } else if (Math.abs(was.volume - bodyHealth.volume) > 1e-6 * Math.max(1, was.volume) || was.faces !== bodyHealth.faces) {
          step.changed.push({ body: bodyHealth.name, from: was.volume, to: bodyHealth.volume });
        }
        if (was?.healthy && !bodyHealth.healthy) {
          step.broke.push(bodyHealth.name);
        }
        if (!was && !bodyHealth.healthy) {
          step.broke.push(bodyHealth.name);
        }
      }
      for (const [id, bodyHealth] of before) {
        if (!now.has(id)) {
          step.gone.push(bodyHealth.name);
        }
      }
      steps.push(step);
      before = now;
    }
  }
  const rebuilt = await regenerate(features);
  const names = new Map(rebuilt.bodies.map(b => [b.id, b.name]));
  const bodies = bodiesNow(names);
  const byId = new Map(features.map(feature => [feature.id, feature]));
  const errors = rebuilt.errors.map(e => ({ step: byId.get(e.featureId)?.name ?? e.featureId, message: e.message }));

  return { name, ...(stepwise ? { steps } : {}), bodies, errors, ok: !errors.length && bodies.every(b => b.healthy) };
}

const formatNumber = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(3));

/** The report as lines to read. */
export function reportText(rep: CheckReport): string {
  const out: string[] = [`Project: ${rep.name}`];
  if (rep.steps) {
    out.push('', 'Steps:');
    for (const step of rep.steps) {
      const what: string[] = [];
      if (step.off) {
        what.push('switched off');
      }
      if (step.made.length) {
        what.push(`made ${step.made.join(', ')}`);
      }
      for (const change of step.changed) {
        what.push(`${change.body} ${change.to >= change.from ? '+' : ''}${formatNumber(change.to - change.from)} mm³`);
      }
      if (step.gone.length) {
        what.push(`took away ${step.gone.join(', ')}`);
      }
      if (step.broke.length) {
        what.push(`!! not sound after it: ${step.broke.join(', ')}`);
      }
      if (step.note) {
        what.push(`note: ${step.note}`);
      }
      if (step.error) {
        what.push(`ERROR: ${step.error}`);
      }
      out.push(`${String(step.index).padStart(3)}. ${step.name} [${step.type}]${what.length ? ' - ' + what.join('; ') : ''}  (${step.ms} ms)`);
    }
  }
  out.push('', 'Bodies:');
  if (!rep.bodies.length) {
    out.push('  (none)');
  }
  for (const b of rep.bodies) {
    const size = b.box[1].map((value, axis) => formatNumber(value - b.box[0][axis])).join(' x ');
    const bad: string[] = [];
    if (!b.valid) {
      bad.push('invalid');
    }
    if (b.solids !== 1) {
      bad.push(`${b.solids} solids`);
    }
    if (b.openEdges) {
      bad.push(`${b.openEdges} open edges`);
    }
    if (b.thin) {
      bad.push(`${b.thin} hair-thin faces`);
    }
    if (!(b.volume > 0)) {
      bad.push('no volume');
    }
    out.push(`  ${b.healthy ? 'ok  ' : 'BAD '} ${b.name}: ${formatNumber(b.volume)} mm³, ${b.faces} faces, ${b.edges} edges, ${size} mm${bad.length ? ' - ' + bad.join(', ') : ''}`);
  }
  if (rep.errors.length) {
    out.push('', 'Errors:');
    for (const e of rep.errors) {
      out.push(`  ${e.step}: ${e.message}`);
    }
  }
  out.push('', rep.ok ? 'All sound.' : 'Not all sound.');

  return out.join('\n');
}

// ------------------------------------------------------------------ command line

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check.ts')) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--') && !/\.png$/i.test(a));
  if (!file) {
    console.log('Usage: npx tsx scripts/check.ts <project.super> [--end] [--json] [--png out.png] [--view iso|front|top|right|...]');
    process.exit(2);
  }
  const doc = parseProject(readFileSync(file, 'utf8'));
  setOC(await (opencascade as unknown as () => Promise<any>)());
  const rep = await checkProject(doc.features, doc.name, !args.includes('--end'));
  console.log(args.includes('--json') ? JSON.stringify(rep, null, 2) : reportText(rep));
  const png = args[args.indexOf('--png') + 1];
  if (args.includes('--png') && png) {
    const view = args.includes('--view') ? (args[args.indexOf('--view') + 1] as RenderOptions['view']) : 'iso';
    const hidden = new Set(doc.hidden ?? []);
    renderPNG([...debugBodies()].filter(([id]) => !hidden.has(id)).map(([id, shape]) => ({ shape, color: doc.colors?.[id] })), png, { view });
    console.log(`Picture: ${png}`);
  }
  process.exit(rep.ok ? 0 : 1);
}
