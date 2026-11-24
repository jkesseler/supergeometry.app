import { useEffect, useRef } from 'preact/hooks';
import { textField, type TextField as TextFieldElement } from './textField';
import { twoTap } from './ui';

interface TextButtonProps {
  label: string;
  /** Shown only where a mouse points. */
  keyHint?: string;
  isPrimary?: boolean;
  isDisabled?: boolean;
  onClick: () => void;
}

export function TextButton({ label, keyHint, isPrimary, isDisabled, onClick }: TextButtonProps) {
  const shouldShowHint = !!keyHint && matchMedia('(pointer: fine)').matches;

  return (
    <button type="button" class={isPrimary ? 'text-btn primary' : 'text-btn'} disabled={isDisabled} onClick={onClick}>
      {label}
      {shouldShowHint && <kbd>{keyHint}</kbd>}
    </button>
  );
}

interface TextFieldProps {
  className?: string;
  /** Shown at first, and again whenever it changes unless the box has the focus. */
  value?: string;
  inputMode?: 'decimal' | 'numeric' | 'text';
  /** Fires when the box is left changed. */
  onChange?: (value: string) => void;
  isMultiline?: boolean;
  placeholder?: string;
  maxLength?: number;
  onInput?: (value: string) => void;
  onReady?: (field: TextFieldElement) => void;
}

/** The app's typing box (see textField.ts) as a component. */
export function TextField({ className, value, inputMode, isMultiline, placeholder, maxLength, onInput, onChange, onReady }: TextFieldProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const fieldRef = useRef<TextFieldElement | undefined>(undefined);
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const field = textField(className, { multiline: isMultiline });
    fieldRef.current = field;
    field.addEventListener('input', () => onInputRef.current?.(field.value));
    field.addEventListener('change', () => onChangeRef.current?.(field.value));
    if (inputMode) {
      field.inputMode = inputMode;
    }
    if (value !== undefined) {
      field.value = value;
    }
    hostRef.current!.append(field);
    onReady?.(field);

    return () => field.remove();
  }, []);

  useEffect(() => {
    if (fieldRef.current && value !== undefined && document.activeElement !== fieldRef.current) {
      fieldRef.current.value = value;
    }
  }, [value]);

  useEffect(() => {
    if (fieldRef.current) {
      fieldRef.current.placeholder = placeholder ?? '';
    }
  }, [placeholder]);

  useEffect(() => {
    if (fieldRef.current) {
      fieldRef.current.maxLength = maxLength ?? 0;
    }
  }, [maxLength]);

  return <span ref={hostRef} style={{ display: 'contents' }} />;
}

interface TwoTapButtonProps {
  /** Which button is armed (see twoTap in ui.ts). */
  armKey: string;
  title: string;
  class: string;
  html: string;
  onConfirm: () => void;
}

/** A button that needs two taps (the first arms it). */
export function TwoTapButton({ armKey, title, class: className, html, onConfirm }: TwoTapButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  useEffect(() => {
    twoTap(buttonRef.current!, armKey, () => onConfirmRef.current());
  }, [armKey]);

  return <button ref={buttonRef} type="button" class={className} title={title} dangerouslySetInnerHTML={{ __html: html }} />;
}

interface RefButtonProps {
  /** The icon, as SVG markup. */
  html: string;
  title: string;
  onClick: () => void;
}

/** A small button in a floating window's bar. */
export function RefButton({ html, title, onClick }: RefButtonProps) {
  return <button type="button" class="ref-btn" title={title} aria-label={title} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Follows a pressed pointer: `onMove` for each move, `onEnd` when it is lifted
 * or cancelled (the end event's type says which). The element keeps the pointer.
 */
export function trackPointer(target: HTMLElement, event: PointerEvent, onMove: (moveEvent: PointerEvent) => void, onEnd: (endEvent: PointerEvent) => void): void {
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    // (a pointer already gone)
  }
  const end = (endEvent: PointerEvent) => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    onEnd(endEvent);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}
