import { useEffect, useState } from 'preact/hooks';
import { fmtLen } from '../units';
import { Modal, openOverlay } from './components';
import type { BodyHealth } from '../kernel/protocol';

export interface PrintShareFile {
  label: string;
  note: string;
  run: () => void;
}

export interface PrintShareProps {
  files: PrintShareFile[];
  checkModel: () => Promise<BodyHealth[]>;
  onClose: () => void;
}

type Check = { state: 'checking' } | { state: 'failed' } | { state: 'done'; bodies: BodyHealth[] };

function problemsOf(body: BodyHealth): string {
  const why = [body.openEdges ? 'it is not closed (open edges)' : '', body.thin ? 'it has hair-thin faces' : '', body.pinched ? 'parts of it only touch along an edge' : '', body.solids > 1 ? `it is ${body.solids} separate pieces` : '', !body.valid ? 'its shape has a fault' : ''].filter(Boolean);

  return `${body.name}: ${why.join(', ') || 'it may not print as it is'}. Modify, Fix, Repair Body may mend it.`;
}

function sizeOf(bodies: BodyHealth[]): string {
  return [0, 1, 2]
    .map((axis) => {
      const low = Math.min(...bodies.map(body => body.box[0][axis]));
      const high = Math.max(...bodies.map(body => body.box[1][axis]));

      return fmtLen(high - low, 1);
    })
    .join(' x ');
}

function CheckResult({ check }: { check: Check }) {
  if (check.state === 'checking') {
    return <>Checking the model…</>;
  }
  if (check.state === 'failed') {
    return <>The model could not be checked. The files can still be saved.</>;
  }
  const { bodies } = check;
  const bad = bodies.filter(body => !body.healthy);

  return (
    <>
      {!bodies.length && <div class="print-warn">Nothing to print yet: there is no solid body.</div>}
      {bodies.length > 0 && !bad.length && <div class="print-ok">{bodies.length === 1 ? 'Ready to print: the body is closed and solid.' : `Ready to print: all ${bodies.length} bodies are closed and solid.`}</div>}
      {bad.map(body => (
        <div class="print-warn" key={body.id}>
          {problemsOf(body)}
        </div>
      ))}
      {bodies.length > 0 && <div class="print-ok">Size: {sizeOf(bodies)}</div>}
    </>
  );
}

function PrintShare({ files, checkModel, onClose }: PrintShareProps) {
  const [check, setCheck] = useState<Check>({ state: 'checking' });
  useEffect(() => {
    let isOpen = true;
    checkModel().then(
      bodies => isOpen && setCheck({ state: 'done', bodies }),
      () => isOpen && setCheck({ state: 'failed' })
    );

    return () => {
      isOpen = false;
    };
  }, []);

  return (
    <Modal title="Print / Share" className="print-share" onClose={onClose}>
      <div class="print-check">
        <CheckResult check={check} />
      </div>
      <div class="print-files">
        {files.map(file => (
          <button
            class="text-btn print-file"
            type="button"
            key={file.label}
            onClick={() => {
              onClose();
              file.run();
            }}
          >
            <b>{file.label}</b>
            <span>{file.note}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** Print / Share: is the model fit to print, and the files to take it away as. */
export function showPrintShare(props: Omit<PrintShareProps, 'onClose'>): void {
  openOverlay(close => <PrintShare {...props} onClose={close} />);
}
