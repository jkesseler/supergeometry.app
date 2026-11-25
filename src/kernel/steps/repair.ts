import { need } from '../bodies';
import { healthOf, repairShape } from '../repair';
import { editNotes } from '../faceEdit';
import type { RepairFeature } from '../../doc/types';
import type { Ctx } from '../types';

export function applyRepair(feature: RepairFeature, ctx: Ctx) {
  const { bodies } = ctx;
  for (const id of feature.bodies) {
    const body = need(bodies, id);
    const repaired = repairShape(body);
    if (!repaired) {
      throw new Error(`This body can't be made a clean solid: ${whatsWrong(healthOf(body))}`);
    }
    editNotes.push(repaired.fixes.length ? `Repaired: ${repaired.fixes.join(', ')}.` : "Nothing to repair - it's a clean solid already.");
    bodies.set(id, repaired.shape);
  }
}

/** What's wrong with a body, in words (for a repair that couldn't fix it). */
function whatsWrong(health: ReturnType<typeof healthOf>): string {
  const out: string[] = [];
  if (!health.solids) {
    out.push(health.shells ? "it's a surface that doesn't close" : 'it has no surface that encloses anything');
  }
  if (health.openEdges) {
    out.push(`${health.openEdges} open edge${health.openEdges > 1 ? 's' : ''} (a gap or a missing curved face)`);
  }
  if (!health.valid) {
    out.push("faces that don't meet up");
  }
  if (health.thin) {
    out.push(`${health.thin} hair-thin face${health.thin > 1 ? 's' : ''}`);
  }

  return out.join(', ') || "it doesn't enclose a volume";
}
