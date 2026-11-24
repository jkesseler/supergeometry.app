// Color → Custom…: a colour card like the app's other windows (the browser's
// own colour window looked different on every device). A square for how pale
// or dark, a strip for the hue, the hex code to type, and the body changing
// as you go. Done keeps it; Cancel (or Esc, or a tap outside) puts it back.

import { render as mount } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { TextButton, TextField } from './components';
import type { TextField as TextFieldElement } from './textField';

type HSV = [number, number, number];

function hexToHsv(hex: string): HSV {
  const rgb = parseInt(hex.replace('#', ''), 16);
  const red = ((rgb >> 16) & 255) / 255;
  const green = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(red, green, b);
  const chroma = max - Math.min(red, green, b);
  let hue = 0;
  if (chroma > 0) {
    hue = max === red ? ((green - b) / chroma + 6) % 6 : max === green ? (b - red) / chroma + 2 : (red - green) / chroma + 4;
  }

  return [hue * 60, max ? chroma / max : 0, max];
}

function hsvToHex([hue, saturation, brightness]: HSV): string {
  const channel = (channelOffset: number) => {
    const x = (channelOffset + hue / 60) % 6;

    return Math.round((brightness - brightness * saturation * Math.max(0, Math.min(x, 4 - x, 1))) * 255);
  };

  return '#' + [channel(5), channel(3), channel(1)].map(channelValue => channelValue.toString(16).padStart(2, '0')).join('');
}

const HEX = /^#?[0-9a-f]{6}$/i;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Pointer handlers that report a drag as the fraction (0..1) across and down the element. */
function useDrag(onPoint: (fractionX: number, fractionY: number) => void) {
  const isDraggingRef = useRef(false);
  const onPointRef = useRef(onPoint);
  onPointRef.current = onPoint;
  const report = (event: PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    onPointRef.current(clamp01((event.clientX - rect.left) / rect.width), clamp01((event.clientY - rect.top) / rect.height));
  };

  return {
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault();
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // (no live pointer to hold)
      }
      isDraggingRef.current = true;
      report(event);
    },
    onPointerMove: (event: PointerEvent) => isDraggingRef.current && report(event),
    onPointerUp: () => (isDraggingRef.current = false),
    onPointerCancel: () => (isDraggingRef.current = false)
  };
}

interface ColorDialogProps {
  title: string;
  start: string;
  live: (hex: string) => void;
  onClose: (value: string | null) => void;
}

function ColorDialog({ title, start, live, onClose }: ColorDialogProps) {
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(HEX.test(start) ? start : '#888888'));
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hexFieldRef = useRef<TextFieldElement | undefined>(undefined);
  const isTypingRef = useRef(false);
  const hexRef = useRef('');
  const hex = hsvToHex(hsv);
  hexRef.current = hex;

  useEffect(() => {
    if (hexFieldRef.current && !isTypingRef.current) {
      hexFieldRef.current.value = hex;
    }
    isTypingRef.current = false;
    live(hex);
  }, [hex]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose(null);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        onClose(hexRef.current);
      }
      event.stopPropagation();
    };
    window.addEventListener('keydown', handleKey, true);

    return () => window.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  const handleHexInput = (text: string) => {
    const value = text.trim();
    if (HEX.test(value)) {
      const typedHsv = hexToHsv(value.startsWith('#') ? value : `#${value}`);
      isTypingRef.current = hsvToHex(typedHsv) !== hexRef.current;
      setHsv(typedHsv);
    }
  };

  // The grip along the top (like the tool cards'): drag the window aside to see the body.
  const handleGripDown = (event: PointerEvent) => {
    event.preventDefault();
    const grip = event.currentTarget as HTMLElement;
    const rect = boxRef.current!.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // (no live pointer to hold)
    }
    const move = (moveEvent: PointerEvent) => {
      // Kept whole on screen.
      setPosition({
        x: Math.min(window.innerWidth - rect.width, Math.max(0, moveEvent.clientX - offsetX)),
        y: Math.min(window.innerHeight - rect.height, Math.max(0, moveEvent.clientY - offsetY))
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };

  const hueColor = hsvToHex([hsv[0], 1, 1]);
  const squareHandlers = useDrag((fractionX, fractionY) => setHsv([hsv[0], fractionX, 1 - fractionY]));
  const hueHandlers = useDrag(fractionX => setHsv([Math.min(359.9, fractionX * 360), hsv[1], hsv[2]]));

  return (
    <div class="dialog-back see-through" onPointerDown={event => event.target === event.currentTarget && onClose(null)}>
      <div
        class="dialog color-dialog"
        ref={boxRef}
        style={position ? { position: 'fixed', left: `${position.x}px`, top: `${position.y}px` } : undefined}
      >
        <div class="color-grip" title="Drag to move" onPointerDown={handleGripDown}>
          <span />
        </div>
        <div class="panel-title">{title}</div>
        <div
          class="color-sv"
          style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
          {...squareHandlers}
        >
          <div class="color-dot" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: hex }} />
        </div>
        <div class="color-hue" {...hueHandlers}>
          <div class="color-dot" style={{ left: `${(hsv[0] / 360) * 100}%`, background: hueColor }} />
        </div>
        <div class="color-row">
          <span class="swatch color-preview" style={{ background: hex }} />
          <TextField className="color-hex" maxLength={7} onInput={handleHexInput} onReady={field => (hexFieldRef.current = field)} />
        </div>
        <div class="panel-buttons">
          <TextButton label="Cancel" keyHint="Esc" onClick={() => onClose(null)} />
          <TextButton label="Done" keyHint="Enter" isPrimary onClick={() => onClose(hex)} />
        </div>
      </div>
    </div>
  );
}

/**
 * Resolves with the colour chosen, or null if cancelled. `live` gets each
 * colour while choosing (to show it on the model).
 */
export function pickColor(title: string, start: string, live: (hex: string) => void): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    const close = (value: string | null) => {
      mount(null, host);
      host.remove();
      resolve(value);
    };
    document.body.append(host);
    mount(<ColorDialog title={title} start={start} live={live} onClose={close} />, host);
  });
}
