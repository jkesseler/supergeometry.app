import { render as mount } from 'preact';
import { BETA_TYPES } from '../doc/store';
import { ungroupedSteps } from '../doc/historyGroups';
import { TwoTapButton } from './components';
import { icons, type IconName } from './icons';
import type { FeatureError } from '../kernel/protocol';
import type { Feature, HistoryGroup } from '../doc/types';
import type { HistoryHandlers, MenuRow } from './ui';

export interface HistoryHost {
  list: HTMLElement;
  toast(text: string): void;
  menu(x: number, y: number, rows: (MenuRow | '-')[]): void;
}

interface Snapshot {
  features: readonly Feature[];
  errors: FeatureError[];
  activeId: string | null;
  handlers: HistoryHandlers;
  warnings: Map<string, string>;
}

const toggleIn = (set: Set<string>, id: string) => (set.has(id) ? set.delete(id) : set.add(id));

function Svg({ icon }: { icon: IconName }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: icons[icon] }} />;
}

function IconButton({ icon, title, onClick }: { icon: IconName; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="icon-btn"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Svg icon={icon} />
    </button>
  );
}

/** The History list: steps, folding groups, a breakpoint bar, and the tick boxes for grouping. */
export class HistoryPanel {
  isPicking = false;
  private checked = new Set<string>();
  private closedGroups = new Set<string>();
  private openWarnings = new Set<string>();
  private openSketchSteps = new Set<string>();
  private last: Snapshot | null = null;

  constructor(private host: HistoryHost) {}

  render(features: readonly Feature[], errors: FeatureError[], activeId: string | null, handlers: HistoryHandlers, warnings: Map<string, string> = new Map()): void {
    this.last = { features, errors, activeId, handlers, warnings };
    const ids = new Set(features.map(feature => feature.id));
    for (const id of this.checked) {
      if (!ids.has(id)) {
        this.checked.delete(id);
      }
    }
    mount(<Rows panel={this} snapshot={this.last} />, this.host.list);
  }

  redraw(): void {
    if (this.last) {
      const { features, errors, activeId, handlers, warnings } = this.last;
      this.render(features, errors, activeId, handlers, warnings);
    }
  }

  setPicking(isPicking: boolean): void {
    this.isPicking = isPicking;
    if (!isPicking) {
      this.checked.clear();
    }
    document.getElementById('history-pick')?.classList.toggle('on', isPicking);
    this.redraw();
  }

  isChecked(id: string): boolean {
    return this.checked.has(id);
  }

  check(id: string, isOn = !this.checked.has(id)): void {
    if (isOn) {
      this.checked.add(id);
    } else {
      this.checked.delete(id);
    }
    this.redraw();
  }

  isClosed(groupId: string): boolean {
    return this.closedGroups.has(groupId);
  }

  fold(groupId: string): void {
    toggleIn(this.closedGroups, groupId);
    this.redraw();
  }

  unfold(groupId: string): void {
    this.closedGroups.delete(groupId);
  }

  hasWarningOpen(id: string): boolean {
    return this.openWarnings.has(id);
  }

  toggleWarning(id: string): void {
    toggleIn(this.openWarnings, id);
    this.redraw();
  }

  hasStepsOpen(id: string): boolean {
    return this.openSketchSteps.has(id);
  }

  toggleSteps(id: string): void {
    toggleIn(this.openSketchSteps, id);
    this.redraw();
  }

  get checkedCount(): number {
    return this.checked.size;
  }

  get toast(): HistoryHost['toast'] {
    return this.host.toast;
  }

  get menu(): HistoryHost['menu'] {
    return this.host.menu;
  }

  private finishPicking(): void {
    this.checked.clear();
    this.isPicking = false;
    document.getElementById('history-pick')?.classList.remove('on');
  }

  /** Group the ticked steps: everything from the first to the last of them (groups are runs of steps). */
  async group({ features, handlers }: Snapshot): Promise<void> {
    const order = features.map(feature => feature.id);
    const positions = [...this.checked].map(id => order.indexOf(id)).filter(position => position >= 0);
    if (!positions.length) {
      return;
    }
    let first = Math.min(...positions);
    let last = Math.max(...positions);
    // A group it runs into joins it (groups don't overlap).
    let rest = handlers.groups;
    let hasGrown = true;
    while (hasGrown) {
      hasGrown = false;
      const kept: HistoryGroup[] = [];
      for (const existing of rest) {
        const existingPositions = existing.steps.map(id => order.indexOf(id)).filter(position => position >= 0);
        if (existingPositions.length && Math.max(...existingPositions) >= first && Math.min(...existingPositions) <= last) {
          first = Math.min(first, ...existingPositions);
          last = Math.max(last, ...existingPositions);
          hasGrown = true;
        } else {
          kept.push(existing);
        }
      }
      rest = kept;
    }
    const name = await handlers.askName('New group', `Group ${handlers.groups.length + 1}`);
    if (!name) {
      return;
    }
    const group: HistoryGroup = { id: `hgroup-${Date.now().toString(36)}`, name, steps: order.slice(first, last + 1) };
    this.finishPicking();
    handlers.setGroups([...rest, group]);
    if (last - first + 1 > positions.length) {
      this.toast('Groups hold steps next to each other: the ones in between went in too');
    }
  }

  /**
   * The ticked steps out of their groups. They stay where they are in the
   * timeline (steps aren't moved): a group they were in the middle of splits
   * in two around them, so they show in their own place between the halves.
   */
  ungroup({ features, handlers }: Snapshot): void {
    const remaining = ungroupedSteps(features.map(feature => feature.id), handlers.groups, this.checked);
    const count = [...this.checked].filter(id => handlers.groups.some(group => group.steps.includes(id))).length;
    this.finishPicking();
    handlers.setGroups(remaining);
    this.toast(`${count} step${count === 1 ? '' : 's'} out of the group, in ${count === 1 ? 'its' : 'their'} place in the timeline`);
  }
}

function Rows({ panel, snapshot }: { panel: HistoryPanel; snapshot: Snapshot }) {
  const { features, errors, activeId, handlers, warnings } = snapshot;
  if (features.length === 0) {
    return <li class="history-empty">Nothing yet. Start with Sketch.</li>;
  }
  const ids = new Set(features.map(feature => feature.id));
  const groupOf = new Map<string, HistoryGroup>();
  for (const group of handlers.groups) {
    for (const id of group.steps) {
      if (ids.has(id)) {
        groupOf.set(id, group);
      }
    }
  }
  const started = new Set<string>();
  const firstRolledBack = features.find(feature => feature.rolledBack)?.id;
  const rows = features.flatMap((feature) => {
    const group = groupOf.get(feature.id);
    const out = [];
    if (feature.id === firstRolledBack) {
      out.push(<BreakpointBar key="breakpoint" handlers={handlers} />);
    }
    if (group && !started.has(group.id)) {
      started.add(group.id);
      const members = features.filter(member => groupOf.get(member.id) === group);
      // The step being edited is inside: show it.
      if (members.some(member => member.id === activeId)) {
        panel.unfold(group.id);
      }
      out.push(<GroupRow key={group.id} panel={panel} group={group} members={members} errors={errors} handlers={handlers} />);
    }
    if (group && panel.isClosed(group.id)) {
      return out;
    }
    out.push(<StepRow key={feature.id} panel={panel} feature={feature} group={group} snapshot={snapshot} hasBreakpoint={!!firstRolledBack} warning={warnings.get(feature.id)} />);
    if (feature.type === 'sketch' && feature.log?.length && panel.hasStepsOpen(feature.id)) {
      out.push(<SketchSteps key={`${feature.id}:steps`} feature={feature} handlers={handlers} />);
    }

    return out;
  });
  const inGroups = [...features].filter(feature => panel.isChecked(feature.id) && groupOf.has(feature.id)).length;

  return (
    <>
      {rows}
      {panel.checkedCount > 0 && (
        <li class="items-actions">
          <button type="button" class="text-btn primary" onClick={() => panel.group(snapshot)}>
            Group ({panel.checkedCount})
          </button>
          {inGroups > 0 && (
            <button type="button" class="text-btn history-ungroup" title="Take the ticked steps out of their group (they stay in their place in the timeline)" onClick={() => panel.ungroup(snapshot)}>
              <Svg icon="ungroup" /> Ungroup ({inGroups})
            </button>
          )}
        </li>
      )}
      {panel.checkedCount === 0 && panel.isPicking && <li class="history-empty">Tick steps to group them, or ungroup them.</li>}
    </>
  );
}

function BreakpointBar({ handlers }: { handlers: HistoryHandlers }) {
  return (
    <li class="history-break">
      <span class="history-break-label">Breakpoint - the steps below are off</span>
      <button type="button" class="text-btn history-break-remove" title="Remove the breakpoint: every step on again" onClick={() => handlers.breakAfter?.(null)}>
        Remove
      </button>
    </li>
  );
}

interface StepRowProps {
  panel: HistoryPanel;
  feature: Feature;
  group: HistoryGroup | undefined;
  snapshot: Snapshot;
  hasBreakpoint: boolean;
  warning: string | undefined;
}

function StepRow({ panel, feature, group, snapshot, hasBreakpoint, warning }: StepRowProps) {
  const { errors, activeId, handlers } = snapshot;
  const error = errors.find(candidate => candidate.featureId === feature.id);
  const isChecked = panel.isChecked(feature.id);
  // A sketch, plane or axis: the eye shows or hides it, like everywhere else. Switching one off broke every step
  // made from it when a beginner only wanted its lines out of the way.
  const canHide = (feature.type === 'sketch' || feature.type === 'plane' || feature.type === 'axis') && !feature.suppressed && !!handlers.toggleHidden;
  const isHidden = canHide && !!handlers.isHidden?.(feature.id);
  const steps = feature.type === 'sketch' ? (feature.log ?? []) : [];
  const hasWarning = !!warning && !error;
  const classes = ['history-item', group && 'in-group', isChecked && 'checked', error && 'error', feature.suppressed && 'suppressed', feature.rolledBack && 'rolled-back', feature.id === activeId && 'active', isHidden && 'hidden-step'].filter(Boolean).join(' ');

  return (
    <li
      class={classes}
      onPointerEnter={() => handlers.hover?.(feature.id)}
      onPointerLeave={() => handlers.hover?.(null)}
      onContextMenu={(event) => {
        event.preventDefault();
        panel.menu(event.clientX, event.clientY, [
          { label: 'Edit', run: () => handlers.edit(feature.id) },
          ...(canHide ? [{ label: isHidden ? 'Show' : 'Hide', run: () => handlers.toggleHidden!(feature.id) }] : []),
          { label: feature.suppressed ? 'Enable' : 'Suppress', run: () => handlers.toggle(feature.id) },
          ...(handlers.breakAfter ? [{ label: 'Insert Breakpoint After', run: () => handlers.breakAfter!(feature.id) }] : []),
          ...(handlers.breakAfter && hasBreakpoint ? [{ label: 'Remove Breakpoint', run: () => handlers.breakAfter!(null) }] : []),
          ...(handlers.merge ? ['-' as const, { label: 'Merge History…', run: () => handlers.merge!() }] : []),
          '-',
          { label: 'Delete', shortcut: 'Del', run: () => handlers.remove(feature.id) }
        ]);
      }}
    >
      {hasWarning && (
        <button
          type="button"
          class="history-warn"
          title={warning}
          onClick={(event) => {
            event.stopPropagation();
            panel.toggleWarning(feature.id);
          }}
        >
          !
        </button>
      )}
      {panel.isPicking && <input type="checkbox" class="items-check" checked={isChecked} onChange={() => panel.check(feature.id)} />}
      {steps.length > 0 && (
        <button
          type="button"
          class="history-caret"
          title={panel.hasStepsOpen(feature.id) ? 'Hide the steps in this sketch' : `Show the ${steps.length} step${steps.length > 1 ? 's' : ''} in this sketch`}
          onClick={(event) => {
            event.stopPropagation();
            panel.toggleSteps(feature.id);
          }}
        >
          {panel.hasStepsOpen(feature.id) ? '▾' : '▸'}
        </button>
      )}
      <button
        type="button"
        class="history-name"
        title={error ? error.message : hasWarning ? warning : 'Edit'}
        // Ctrl/Cmd/Shift+click (or Select on): tick it for a group; a plain click edits it.
        onClick={event => (event.ctrlKey || event.metaKey || event.shiftKey || panel.isPicking ? panel.check(feature.id) : handlers.edit(feature.id))}
      >
        {feature.name}
        {BETA_TYPES.has(feature.type) && (
          <span class="beta-tag" title="New and still being tried out: it may change, or not work on every shape">
            BETA
          </span>
        )}
      </button>
      {canHide
        ? <IconButton icon={isHidden ? 'eyeOff' : 'eye'} title={isHidden ? 'Show' : 'Hide'} onClick={() => handlers.toggleHidden!(feature.id)} />
        : <IconButton icon={feature.suppressed ? 'eyeOff' : 'eye'} title={feature.suppressed ? 'Enable' : 'Suppress'} onClick={() => handlers.toggle(feature.id)} />}
      {/* Two taps: the bin sits where a phone user expects the panel's close button, and one stray tap deleted a whole extrude. */}
      <TwoTapButton armKey={`history:${feature.id}`} title="Delete" class="icon-btn" html={icons.trash} onConfirm={() => handlers.remove(feature.id)} />
      {error && <div class="history-error">{error.message}</div>}
      {hasWarning && panel.hasWarningOpen(feature.id) && <div class="history-warning-text">{warning}</div>}
    </li>
  );
}

function SketchSteps({ feature, handlers }: { feature: Extract<Feature, { type: 'sketch' }>; handlers: HistoryHandlers }) {
  const steps = feature.log ?? [];
  const shown = steps.length > 12 ? steps.slice(-12) : steps;

  return (
    <li class="history-steps">
      {steps.length > shown.length && <div class="history-step more">… {steps.length - shown.length} earlier</div>}
      {shown.map((step, index) => {
        // What the step made or changed that is still in the sketch: picked when its line is tapped.
        const still = (step.ids ?? []).filter(id => feature.entities.some(entity => entity.id === id));

        return (
          <button
            type="button"
            key={index}
            class="history-step"
            title={still.length ? `Open the sketch with ${still.length === 1 ? 'this curve' : `these ${still.length} curves`} picked, to change ${still.length === 1 ? 'it' : 'them'}` : 'Open the sketch'}
            onClick={() => handlers.edit(feature.id, still)}
          >
            {step.op}
            {step.n > 1 ? ` ×${step.n}` : ''}
          </button>
        );
      })}
    </li>
  );
}

function GroupRow({ panel, group, members, errors, handlers }: { panel: HistoryPanel; group: HistoryGroup; members: Feature[]; errors: FeatureError[]; handlers: HistoryHandlers }) {
  const isClosed = panel.isClosed(group.id);
  const hasFailure = members.some(member => errors.some(error => error.featureId === member.id));
  const isAllOff = members.every(member => member.suppressed);
  const tickedCount = members.filter(member => panel.isChecked(member.id)).length;
  const fold = (event: Event) => {
    event.stopPropagation();
    panel.fold(group.id);
  };

  return (
    <li class={`history-item history-group${hasFailure ? ' error' : ''}${isAllOff ? ' suppressed' : ''}`}>
      {panel.isPicking && (
        <input
          type="checkbox"
          class="items-check"
          checked={tickedCount === members.length}
          ref={(box) => {
            if (box) {
              box.indeterminate = tickedCount > 0 && tickedCount < members.length;
            }
          }}
          onChange={(event) => {
            const isOn = (event.target as HTMLInputElement).checked;
            for (const member of members) {
              panel.check(member.id, isOn);
            }
          }}
        />
      )}
      <button type="button" class="history-caret" title={isClosed ? `Show the ${members.length} steps` : 'Fold the group'} onClick={fold}>
        {isClosed ? '▸' : '▾'}
      </button>
      <button type="button" class="history-name" title={hasFailure ? 'A step in this group failed - open it to see' : 'Fold / unfold'} onClick={fold}>
        <Svg icon="folder" /> {group.name}
        <span class="history-count"> {members.length}</span>
      </button>
      <IconButton icon={isAllOff ? 'eyeOff' : 'eye'} title={isAllOff ? 'Enable all its steps' : 'Suppress all its steps'} onClick={() => handlers.suppress(members.map(member => member.id), !isAllOff)} />
      <IconButton
        icon="rename"
        title="Rename group"
        onClick={() =>
          handlers.askName('Rename group', group.name).then(name => name && handlers.setGroups(handlers.groups.map(existing => (existing.id === group.id ? { ...existing, name } : existing))))}
      />
      <IconButton icon="ungroup" title="Ungroup (the steps stay, in their place in the timeline)" onClick={() => handlers.setGroups(handlers.groups.filter(existing => existing.id !== group.id))} />
    </li>
  );
}
