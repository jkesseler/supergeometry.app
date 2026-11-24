// The tool menus: the left column (what's offered for the picked thing) and the bottom row.

import { BooleanOp } from '../tools/booleanOp';
import { SectionTool } from '../tools/section';
import { FreeformTool } from '../tools/freeform';
import { AxisOp, ConnectOp, EdgeOp, ExtrudeOp, FillOp, FillToPlaneOp, ImageOp, LoftOp, MidplaneOp, PlaneOp, ReplaceFaceOp, ScaleOp, RevolveOp, ShellOp, SplitOp, SweepOp, TransformOp } from '../tools/ops';
import { faceFreeformTool } from '../tools/faceFreeform';
import { OffsetEdgeOp } from '../tools/offsetEdge';
import { openDrawing } from '../bim/drawing';
import { openSheet } from '../bim/sheet';
import { BimTool } from '../bim/bimTool';
import { MeasureTool } from '../tools/measure';
import { VariablesTool } from '../tools/variablesTool';
import { insertFile, insertImage } from '../io/insert';
import { WrapOp } from '../tools/wrapOps';
import { PlanesAxisOp, TwoPointAxisOp, surfaceAxis } from '../tools/axisOps';
import { CurvePointPlaneOp, EdgeAnglePlaneOp, FacePointPlaneOp, ThreePointPlaneOp } from '../tools/planeOps';
import { circleAxis } from '../tools/slots';
import { SketchTool } from '../tools/sketch';
import { AssemblyTool } from '../assembly/assemblyTool';
import { bodiesOf, edgeRefOf, edgesOfFace, faceRefOf, sourcesOf, type Sel } from '../tools/tool';
import type { ToolItem } from '../ui/ui';
import type { EdgeRef, ExtrudeSource, PathRef } from '../doc/types';
import type { App } from '../app';

export class Menus {
  constructor(private app: App) {}

  /** The edges picked for a fillet or chamfer: each edge, and every edge round each face. */
  private pickedEdges(): EdgeRef[] {
    const out: EdgeRef[] = [];
    const have = (edgeRef: EdgeRef) => out.some(e => e.body === edgeRef.body && Math.hypot(e.mid[0] - edgeRef.mid[0], e.mid[1] - edgeRef.mid[1], e.mid[2] - edgeRef.mid[2]) < 1e-6);
    // (A round face's seam - the same face either side - is nothing to round:
    // picked, the step broke with "an edge it was built on is gone".)
    const seam = (body: string, edgeIndex: number) => !!this.app.view.body(body)?.edges[edgeIndex]?.seam;
    let seams = 0;
    for (const highlight of this.app.selection) {
      if (highlight.kind === 'edge' && seam(highlight.body, highlight.edge)) {
        seams++;
      }
      const refs = highlight.kind === 'edge' ? (seam(highlight.body, highlight.edge) ? [] : [edgeRefOf(this.app, highlight)]) : highlight.kind === 'face' ? edgesOfFace(this.app, highlight.body, highlight.face).filter(edgeIndex => !seam(highlight.body, edgeIndex)).map(edgeIndex => edgeRefOf(this.app, { body: highlight.body, edge: edgeIndex })) : [];
      for (const ref of refs) {
        if (ref && !have(ref)) {
          out.push(ref);
        }
      }
    }
    if (seams) {
      this.app.ui.toast('That line is a seam - where a round face starts and ends, no corner there to round or chamfer. Tap a real edge.');
    }

    return out;
  }

  firstShape(): boolean {
    return !this.app.result?.bodies.length && this.app.view.profileCount > 0;
  }

  /** Nothing selected: the top-level menu (the left tool column). */
  mainTools(): ToolItem[] {
    // (Marked: it asks for a pick after it is tapped. The sentence bar leaves those out - there the pick comes first.)
    const wait = (label: string, accepts: Sel['kind'][], run: () => void) =>
      Object.assign(
        () => {
          this.app.selectTool.waitFor(label, accepts, run);
          this.app.selectTool.refresh();
        },
        { needsPick: true }
      );
    const bodies = () => bodiesOf(this.app.selection);
    const transform = (kind: ConstructorParameters<typeof TransformOp>[1], label: string) =>
      wait(label, ['body', 'face', 'edge'], () => this.app.setTool(new TransformOp(this.app, kind, bodies())));
    const src = () => sourcesOf(this.app, this.app.selection)[0];

    return [
      // An empty project: Sketch pulses - that's where to start.
      { id: 'sketch', label: 'Sketch', icon: 'sketch', shortcut: 'S', pulse: this.app.store.features.length === 0, run: () => this.app.setTool(new SketchTool(this.app)) },
      {
        // A shape from a sketch's: pulled, turned, swept, lofted.
        id: 'create',
        label: 'Create',
        icon: 'extrude',
        children: [
          // (The first shape drawn, nothing solid yet: this is the next step, it pulses.)
          { id: 'extrude', label: 'Extrude', icon: 'extrude', pulse: this.firstShape(), run: wait('Extrude', ['profile', 'face'], () => src() && this.app.setTool(new ExtrudeOp(this.app, src()!))) },
          { id: 'revolve', label: 'Revolve', icon: 'revolve', run: wait('Revolve', ['profile', 'face'], () => src() && this.app.setTool(new RevolveOp(this.app, src()!))) },
          { id: 'sweep', label: 'Sweep', icon: 'sweep', run: wait('Sweep', ['profile', 'face'], () => src() && this.app.setTool(new SweepOp(this.app, src()!))) },
          { id: 'loft', label: 'Loft', icon: 'loft', run: wait('Loft', ['profile', 'face'], () => this.app.setTool(new LoftOp(this.app, sourcesOf(this.app, this.app.selection).flatMap((source): ExtrudeSource[] => (source.kind === 'profile' ? source.regions.map(region => ({ ...source, regions: [region] })) : [source])), this.app.selection))) }
        ]
      },
      {
        // A body changed where it is: edges, faces, walls, details.
        id: 'modify',
        label: 'Modify',
        icon: 'fillet',
        children: [
          { id: 'fillet', label: 'Fillet', icon: 'fillet', run: wait('Fillet', ['edge', 'face'], () => this.app.setTool(new EdgeOp(this.app, 'fillet', this.pickedEdges()))) },
          { id: 'chamfer', label: 'Chamfer', icon: 'chamfer', run: wait('Chamfer', ['edge', 'face'], () => this.app.setTool(new EdgeOp(this.app, 'chamfer', this.pickedEdges()))) },
          { id: 'shell', label: 'Shell', icon: 'shell', run: wait('Shell', ['face', 'body'], () => {
            const highlight = this.app.selection[0];
            const faces = this.app.selection.flatMap(highlight => (highlight.kind === 'face' ? [faceRefOf(this.app, highlight)!] : []));
            this.app.setTool(new ShellOp(this.app, bodiesOf([highlight])[0], faces));
          }) },
          { id: 'offsetFace', label: 'Offset Face', icon: 'offsetFace', run: wait('Offset Face', ['face'], () => src() && this.app.setTool(new ExtrudeOp(this.app, src()!))) },
          { id: 'offsetEdge', label: 'Offset Edge', icon: 'offsetEdge', run: () => {
            const edgePick = this.app.selection.find(highlight => highlight.kind === 'edge');
            this.app.setTool(new OffsetEdgeOp(this.app, edgePick?.kind === 'edge' ? edgePick : undefined));
          } },
          { id: 'thread', label: 'Thread', icon: 'thread', run: wait('Thread (tap a round face or its rim)', ['face', 'edge'], () => this.app.startThread()) },
          { id: 'wrap', label: 'Wrap & Emboss', icon: 'wrap', beta: true, run: wait("Wrap & Emboss (tap a sketch's shape)", ['profile'], () => src() && this.app.setTool(new WrapOp(this.app, src()!))) },
          // Holes filled, surfaces closed, broken bodies mended.
          {
            id: 'fix',
            label: 'Fix',
            icon: 'check',
            children: [
              { id: 'fillNetwork', label: 'Fill', icon: 'fill', sub: 'a surface over curves', run: () => this.app.setTool(new FillOp(this.app, this.pickedCurves())) },
              { id: 'fillToPlane', label: 'Fill to Plane', icon: 'fill', run: wait('Fill to Plane (tap the surface)', ['body', 'face', 'edge'], () => this.app.setTool(new FillToPlaneOp(this.app, bodiesOf(this.app.selection)[0]))) },
              {
                id: 'repair',
                label: 'Repair Body',
                icon: 'check',
                run: wait('Repair Body', ['body', 'face', 'edge'], () => {
                  const ids = bodiesOf(this.app.selection);
                  if (!ids.length) {
                    return;
                  }
                  this.app.store.add({ ...this.app.store.newIdentity('repair'), type: 'repair', bodies: ids });
                  this.app.ui.toast('Repair added to History - it notes what it fixed');
                })
              }
            ]
          },
          { id: 'replace', label: 'Replace Face', icon: 'replaceFace', run: wait('Replace Face', ['face'], () => {
            const highlight = this.app.selection[0];
            const ref = highlight?.kind === 'face' ? faceRefOf(this.app, highlight) : null;
            if (ref) {
              this.app.setTool(new ReplaceFaceOp(this.app, ref));
            }
          }) }
        ]
      },
      {
        // Bodies together, apart, or cut in two.
        id: 'combine',
        label: 'Combine',
        icon: 'union',
        children: [
          { id: 'union', label: 'Union', icon: 'union', run: wait('Union (double-tap bodies)', ['body'], () => this.app.selectTool.refresh()) },
          { id: 'subtract', label: 'Subtract', icon: 'subtract', run: () => this.app.setTool(new BooleanOp(this.app, 'subtract')) },
          { id: 'intersect', label: 'Intersect', icon: 'intersect', run: () => this.app.setTool(new BooleanOp(this.app, 'intersect')) },
          { id: 'split', label: 'Split Body', icon: 'split', run: wait('Split Body', ['body', 'face'], () => this.app.setTool(new SplitOp(this.app, bodiesOf(this.app.selection)[0]))) }
        ]
      },
      {
        id: 'transform',
        label: 'Transform',
        icon: 'transform',
        children: [
          // Moved: freely, along a line, round an axis.
          {
            id: 'moveKinds',
            label: 'Move',
            icon: 'move',
            children: [
              { id: 'move', label: 'Move/Rotate', icon: 'move', shortcut: 'M', run: transform('move', 'Move/Rotate') },
              { id: 'translate', label: 'Translate', icon: 'translate', run: transform('translate', 'Translate') },
              { id: 'rotate', label: 'Rotate Around Axis', icon: 'rotateAxis', run: transform('rotate', 'Rotate Around Axis') }
            ]
          },
          { id: 'scale', label: 'Scale', icon: 'scale', run: wait('Scale', ['body', 'face', 'edge'], () => this.app.setTool(new ScaleOp(this.app, false, bodies()))) },
          { id: 'mirror', label: 'Mirror', icon: 'mirror', run: transform('mirror', 'Mirror') },
          {
            id: 'pattern',
            label: 'Pattern',
            icon: 'patternLinear',
            children: [
              { id: 'linear', label: 'Linear', icon: 'patternLinear', run: transform('linear', 'Pattern – Linear') },
              { id: 'circular', label: 'Circular', icon: 'patternCircular', run: transform('circular', 'Pattern – Circular') }
            ]
          }
        ]
      },
      {
        id: 'construct',
        label: 'Construct',
        icon: 'construct',
        children: [
          {
            // A tap: Offset Plane from the face or plane tapped next - or one of the other kinds, picked on the wheel.
            id: 'plane',
            label: 'Plane',
            icon: 'plane',
            startsDefault: 'offset',
            run: wait('Offset Plane', ['face', 'plane'], () => {
              const highlight = this.app.selection[0];
              if (highlight?.kind === 'face') {
                const face = this.app.view.body(highlight.body)?.faces[highlight.face];
                if (face?.plane) {
                  this.app.setTool(new PlaneOp(this.app, face.plane, faceRefOf(this.app, highlight)!));
                } else {
                  this.app.ui.toast('An Offset Plane starts from a flat face or a plane', 'error');
                }
              } else if (highlight?.kind === 'plane') {
                const plane = this.app.view.planeOf(highlight.id);
                if (plane) {
                  this.app.setTool(new PlaneOp(this.app, plane, undefined));
                }
              }
            }),
            children: [
              { id: 'offset', label: 'Offset Plane', short: 'Offset', icon: 'planeOffset', run: () => this.app.setTool(new PlaneOp(this.app, null, undefined)) },
              { id: 'mid', label: 'Midplane', icon: 'planeMid', run: () => this.app.setTool(new MidplaneOp(this.app)) },
              { id: '3pt', label: 'Through 3 Points', short: '3 Points', icon: 'plane3pt', run: () => this.app.setTool(new ThreePointPlaneOp(this.app)) },
              { id: 'curve', label: 'On Curve at Point', short: 'On Curve', icon: 'planeCurve', run: () => this.app.setTool(new CurvePointPlaneOp(this.app, false)) },
              { id: 'perp', label: 'Perpendicular to Edge at Point', short: 'Perpendicular', icon: 'planePerp', run: () => this.app.setTool(new CurvePointPlaneOp(this.app, true)) },
              { id: 'angle', label: 'Through Edge at Angle', short: 'At Angle', icon: 'planeAngle', run: () => this.app.setTool(new EdgeAnglePlaneOp(this.app)) },
              { id: 'parallel', label: 'Parallel to Face at Point', short: 'Parallel', icon: 'planeParallel', run: () => this.app.setTool(new FacePointPlaneOp(this.app)) }
            ]
          },
          {
            id: 'axis',
            label: 'Axis',
            icon: 'axis',
            // (Along X, Y or Z: the origin's own axes, tapped in the view.)
            children: [
              { id: 'axisFace', label: 'Square to Face', short: 'Face', icon: 'axisFace' as const, run: wait('Axis Square to Face', ['face'], () => {
                const highlight = this.app.selection[0];
                const faceInfo = highlight?.kind === 'face' ? this.app.view.body(highlight.body)?.faces[highlight.face] : undefined;
                if (faceInfo) {
                  this.app.setTool(new AxisOp(this.app, faceInfo.center, faceInfo.plane?.normal ?? faceInfo.normal, undefined, 'face'));
                }
              }) },
              { id: 'axisEdge', label: 'Along Edge', short: 'Edge', icon: 'axisEdge' as const, run: wait('Axis Along Edge', ['edge'], () => {
                const highlight = this.app.selection[0];
                const e = highlight?.kind === 'edge' ? this.app.view.body(highlight.body)?.edges[highlight.edge] : undefined;
                // A round edge: through its centre, square to it.
                const ax = e && (e.type === 'CIRCLE' ? circleAxis(e.start, e.mid, e.end, e.dir) : { origin: e.start, dir: e.dir });
                if (ax) {
                  this.app.setTool(new AxisOp(this.app, ax.origin, ax.dir, undefined, e.type === 'CIRCLE' ? 'round' : 'edge'));
                }
              }) },
              { id: 'axisRound', label: 'Cylinder / Cone', icon: 'axisRound' as const, run: wait('Axis of Cylinder / Cone', ['face'], () => {
                const highlight = this.app.selection[0];
                const ax = highlight?.kind === 'face' ? surfaceAxis(this.app, highlight.body, highlight.face) : null;
                if (ax) {
                  this.app.setTool(new AxisOp(this.app, ax.origin, ax.dir, undefined, 'round'));
                } else {
                  this.app.ui.toast('Tap a round face - a cylinder, a hole or a cone - for the axis through its middle', 'error');
                }
              }) },
              { id: 'axis2pt', label: 'Point to Point', icon: 'axis2pt' as const, run: () => this.app.setTool(new TwoPointAxisOp(this.app)) },
              { id: 'axisPlanes', label: 'Intersection of 2 Planes', short: '2 Planes', icon: 'axisPlanes' as const, run: () => this.app.setTool(new PlanesAxisOp(this.app)) }
            ]
          }
        ]
      },
      {
        // Smooth shapes from a control cage.
        id: 'freeform',
        label: 'Freeform',
        icon: 'freeform',
        children: [
          ...(['box', 'sphere', 'cylinder', 'torus', 'plane'] as const).map(primitive => ({
            id: `ff-${primitive}`,
            label: { box: 'Box', sphere: 'Sphere', cylinder: 'Cylinder', torus: 'Torus', plane: 'Surface' }[primitive],
            icon: ({ box: 'ffBox', sphere: 'ffSphere', cylinder: 'ffCylinder', torus: 'ffTorus', plane: 'ffSurface' } as const)[primitive],
            run: () => this.app.setTool(new FreeformTool(this.app, { primitive: primitive }))
          })),
          // A flat face of a body made smooth (its edges stay put).
          {
            id: 'faceFreeform',
            beta: true,
            label: 'Freeform Face',
            icon: 'faceFreeform' as const,
            sub: 'a face of a body',
            run: wait('Freeform Face (tap a flat face)', ['face'], () => {
              const highlight = this.app.selection[0];
              if (highlight?.kind !== 'face' || !this.app.view.body(highlight.body)?.faces[highlight.face]?.plane) {
                return void this.app.ui.toast('Freeform Face works on flat faces for now');
              }
              const t = faceFreeformTool(this.app, highlight);
              if (t) {
                this.app.setTool(t);
              }
            })
          },
          // A smooth bridge between two faces.
          { id: 'connect', label: 'Connect', icon: 'connect' as const, sub: 'two faces', beta: true, run: () => this.app.setTool(new ConnectOp(this.app, this.app.selection.filter(highlight => highlight.kind === 'face').slice(0, 2))) }
        ]
      },
      {
        // Less often: a file or picture brought in, and the project as a building model.
        id: 'more',
        label: 'More',
        icon: 'more',
        children: [
          {
            id: 'insert',
            label: 'Insert',
            icon: 'insert',
            children: [
              { id: 'image', label: 'Image on plane', icon: 'image', run: () => void insertImage(this.app).then(image => image && this.app.setTool(new ImageOp(this.app, image))) },
              { id: 'file', label: 'File', icon: 'file', sub: 'STEP, STL, OBJ, 3MF, DXF, SVG', run: () => void insertFile(this.app) },
              { id: 'project', label: 'Project', icon: 'file', sub: '.super', run: () => void insertFile(this.app) },
              { id: 'refImage', label: 'Reference Image', icon: 'refImage', sub: 'a picture in its own window, over the model', run: () => void this.app.refImages.open() },
              // A web page or a video in a window over the model (open already: brought up again).
              { id: 'browser', label: 'Browser', icon: 'browser', sub: 'a web page or a video, in a window over the model', active: this.app.web.isOpen, run: () => this.app.web.open() }
            ]
          },
          {
            // The project as a building information model: real materials, and
            // from them the technical sheet and the drawings.
            id: 'bim',
            label: 'BIM',
            icon: 'bim',
            children: [
              { id: 'bimMaterials', label: 'Materials', icon: 'bim', sub: 'a real material for each body', run: () => this.app.setTool(new BimTool(this.app)) },
              { id: 'bimSheet', label: 'Technical Sheet', icon: 'sheet', sub: 'parts list, masses, data', run: () => void openSheet(this.app) },
              { id: 'bimDrawings', label: 'Drawings', icon: 'drawing', sub: 'views with dimensions', run: () => void openDrawing(this.app) },
              { id: 'bimAssemblies', label: 'Assemblies', icon: 'assembly', sub: 'joints: how the parts move', run: () => this.app.setTool(new AssemblyTool(this.app)) }
            ]
          }
        ]
      }
    ];
  }

  bottomTools(): ToolItem[] {
    return [
      // The one whose card is open pulses (as a tool does while its window is open).
      { id: 'section', label: 'Section View', icon: 'section', sub: this.app.section ? 'On' : this.app.lastSection ? 'Off · tap to show' : 'Off', active: !!this.app.section, pulse: this.app.tool instanceof SectionTool, run: () => this.app.toggleSection() },
      { id: 'measure', label: 'Measure', icon: 'measure', active: this.app.tool instanceof MeasureTool, pulse: this.app.tool instanceof MeasureTool, run: () => this.app.setTool(this.app.tool instanceof MeasureTool ? null : new MeasureTool(this.app)) },
      // On: a tag per variable in the view (tap one to change it), and their card. Off again.
      { id: 'variables', label: 'Variables', icon: 'variable', sub: this.app.varsOn ? 'On' : this.app.store.doc.variables.length ? `Off · ${this.app.store.doc.variables.length}` : 'Off', active: this.app.varsOn, pulse: this.app.tool instanceof VariablesTool, run: () => this.app.toggleVariables() },
      this.app.isolated
        ? { id: 'isolate', label: 'Isolate', icon: 'isolate', sub: 'On - tap to show all', active: true, run: () => this.app.isolate(null) }
        : {
          id: 'isolate',
          label: 'Isolate',
          icon: 'isolate',
          sub: 'Off',
          disabled: !bodiesOf(this.app.selection).length,
          why: 'Select a body, face or edge to isolate',
          run: () => this.app.isolate(bodiesOf(this.app.selection))
        },
      // The way out with what was made: is it fit to print, and the files to take it away as.
      { id: 'printShare', label: 'Print / Share', icon: 'share', run: () => void this.app.printShare() }
    ];
  }

  /** The picked sketch curves and edges, as paths (one per sketch, one per body): what Fill starts with. */
  private pickedCurves(): PathRef[] {
    const out: PathRef[] = [];
    for (const highlight of this.app.selection) {
      if (highlight.kind === 'curve') {
        const sketchPath = out.find((pathRef): pathRef is Extract<PathRef, { kind: 'sketch' }> => pathRef.kind === 'sketch' && pathRef.sketch === highlight.sketch);
        if (sketchPath) {
          sketchPath.entities.push(highlight.entity);
        } else {
          out.push({ kind: 'sketch', sketch: highlight.sketch, entities: [highlight.entity] });
        }
      } else if (highlight.kind === 'edge') {
        const ref = edgeRefOf(this.app, highlight);
        if (!ref) {
          continue;
        }
        const edgePath = out.find((pathRef): pathRef is Extract<PathRef, { kind: 'edges' }> => pathRef.kind === 'edges' && pathRef.edges[0]?.body === ref.body);
        if (edgePath) {
          edgePath.edges.push(ref);
        } else {
          out.push({ kind: 'edges', edges: [ref] });
        }
      }
    }

    return out;
  }
}
