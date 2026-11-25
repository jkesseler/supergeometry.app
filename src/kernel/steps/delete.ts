import { bodyList } from '../bodies';
import type { DeleteFeature } from '../../doc/types';
import type { Ctx } from '../types';

export function applyDelete(feature: DeleteFeature, ctx: Ctx) {
  for (const id of bodyList(feature.bodies, ctx.bodies, 'bodies', feature.whole)) {
    ctx.bodies.delete(id);
  }
}
