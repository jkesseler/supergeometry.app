import { render as mount } from 'preact';
import { icons, type IconName } from './icons';
import { usable, type ToolItem } from './ui';

function Svg({ icon }: { icon: IconName }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: icons[icon] }} />;
}

/** The small BETA tag on a tool still being tried out. */
export function BetaTag() {
  return (
    <span class="beta-tag" title="New and still being tried out: it may change, or not work on every shape">
      BETA
    </span>
  );
}

interface ToolButtonProps {
  item: ToolItem;
  onClick: (event: MouseEvent) => void;
}

function ToolButton({ item, onClick }: ToolButtonProps) {
  const classes = ['tool', item.active && 'active', item.pulse && 'pulse', item.children?.length && 'has-children', item.disabled && 'disabled'].filter(Boolean).join(' ');
  const title = item.disabled && item.why ? item.why : item.shortcut ? `${item.label} (${item.shortcut})` : item.label;

  return (
    <button type="button" class={classes} data-tool={item.id} data-label={item.label} title={title} onClick={onClick}>
      {/* A colour comes from the project - a file someone else may have made: it is given to the swatch as a colour, never written into the page as markup. */}
      {item.swatch ? <span class="swatch" style={{ background: item.swatch }} /> : <Svg icon={item.icon} />}
      <span class="tool-label">
        <span class="tool-name">
          {item.label}
          {item.beta && <BetaTag />}
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </span>
        {item.sub && <span class="tool-sub">{item.sub}</span>}
      </span>
      {item.trailing?.length ? <span class="tool-trailing" dangerouslySetInnerHTML={{ __html: item.trailing.map(icon => icons[icon]).join('') }} /> : null}
    </button>
  );
}

interface ToolListProps {
  items: ToolItem[];
  /** A tool with options: open them beside this button. */
  onFlyout: (item: ToolItem, button: HTMLElement) => void;
  /** After a tool without options was run. */
  after?: () => void;
}

function ToolList({ items, onFlyout, after }: ToolListProps) {
  return (
    <>
      {usable(items).map((item, index) => {
        if (item.id.startsWith('---')) {
          return <div class="tool-sep" key={`sep-${index}`} />;
        }

        return (
          <ToolButton
            key={item.id}
            item={item}
            onClick={(event) => {
              event.stopPropagation();
              if (item.disabled) {
                return;
              }
              if (item.children?.length && !(item.variantsWhenActive && !item.active && item.run)) {
                onFlyout(item, event.currentTarget as HTMLElement);
              } else {
                item.run?.();
                after?.();
              }
            }}
          />
        );
      })}
    </>
  );
}

/** Draws a column or strip of tools into `host` (drawn again in place when the tools change). */
export function renderTools(host: HTMLElement, items: ToolItem[], onFlyout: ToolListProps['onFlyout'], after?: () => void): void {
  mount(<ToolList items={items} onFlyout={onFlyout} after={after} />, host);
}

interface LeftColumnProps {
  items: ToolItem[];
  /** Run the tool at this place in the latest list (the buttons are not redrawn while nothing about them changed). */
  onPress: (index: number) => void;
}

function LeftColumn({ items, onPress }: LeftColumnProps) {
  return (
    <>
      {items.map((item, index) => (
        <button
          type="button"
          key={item.id}
          class={`right-btn left-btn${item.active ? ' on' : ''}${item.pulse ? ' pulse' : ''}`}
          data-left={item.id}
          title={item.disabled && item.why ? `${item.label}: ${item.why}` : item.label + (item.active ? ' (on - tap to switch off)' : '')}
          onClick={() => onPress(index)}
        >
          <Svg icon={item.icon} />
          <span class="right-label">{item.label.replace(' View', '')}</span>
        </button>
      ))}
    </>
  );
}

/** Isolate, Measure and Section, at the middle of the left edge. */
export function renderLeftColumn(host: HTMLElement, items: ToolItem[], onPress: LeftColumnProps['onPress']): void {
  mount(<LeftColumn items={items} onPress={onPress} />, host);
}

/** The guide text with its × (only the × takes a tap: the words let taps through to the model under them). */
export function renderHint(host: HTMLElement, text: string, onHide: () => void): void {
  mount(
    <>
      <span>{text}</span>
      <button
        type="button"
        class="hint-x"
        title="Hide guide text (More → Guide text shows it again)"
        aria-label="Hide guide text"
        onPointerDown={event => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onHide();
        }}
      >
        ×
      </button>
    </>,
    host
  );
}

/** The label by the pointer: the value, and a tip while it is being typed. */
export function renderPointerLabel(host: HTMLElement, value: string, tip: string | null): void {
  mount(
    <>
      <span class="label-value">{value}</span>
      {tip && <span class="label-tip">{tip}</span>}
    </>,
    host
  );
}
