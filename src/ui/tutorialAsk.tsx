import { render as mount } from 'preact';

interface TutorialAskProps {
  onStart: () => void;
  onClose: () => void;
}

function TutorialAsk({ onStart, onClose }: TutorialAskProps) {
  return (
    <div class="dialog-back">
      <div class="dialog tutorial-ask">
        <div class="panel-title">New here?</div>
        <div class="tutorial-ask-text">The tutorial builds a bolt and the nut that fits it with you, one tap at a time. It takes a few minutes.</div>
        <div class="dialog-actions">
          <button class="text-btn" onClick={onClose}>
            Not now
          </button>
          <button
            class="text-btn primary"
            onClick={() => {
              onClose();
              onStart();
            }}
          >
            Start the tutorial
          </button>
        </div>
        <div class="tutorial-ask-note">It is under More &gt; Tutorial whenever you want it.</div>
      </div>
    </div>
  );
}

/** The question shown the first time the app is opened on a device. */
export function askAboutTutorial(onStart: () => void): void {
  const host = document.createElement('div');
  const close = () => {
    mount(null, host);
    host.remove();
  };
  document.body.append(host);
  mount(<TutorialAsk onStart={onStart} onClose={close} />, host);
}
