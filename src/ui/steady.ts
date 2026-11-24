// The page stays where it is. Nothing in the app scrolls the page itself - every window scrolls inside - but a
// phone's browser can still push the whole page along when a box takes the focus, to keep it clear of a keyboard.
// Our number boxes bring up no keyboard (the numpad is ours), and installed on an iPhone's home screen the page
// was left pushed down by the height of the status bar while touches still landed where things had been: a tap
// on the numpad's 2 typed the 0 under it (reported from an iPhone, the app installed).
//
// So: whenever the page is found scrolled, it is put back; and it is looked at when that can have happened - a
// box taking or losing the focus, the visible part of the page changing.

export function keepPageSteady(): void {
  const root = document.documentElement;
  const settle = () => {
    if (window.scrollX || window.scrollY) {
      window.scrollTo(0, 0);
    }
    if (root.scrollTop || root.scrollLeft) {
      (root.scrollTop = 0), (root.scrollLeft = 0);
    }
    if (document.body.scrollTop || document.body.scrollLeft) {
      (document.body.scrollTop = 0), (document.body.scrollLeft = 0);
    }
  };
  // (Now, once drawn, and once any sliding the browser does has ended.)
  const soon = () => {
    settle();
    requestAnimationFrame(settle);
    setTimeout(settle, 120);
    setTimeout(settle, 400);
  };
  window.addEventListener('scroll', settle, { passive: true });
  window.visualViewport?.addEventListener('scroll', settle);
  window.visualViewport?.addEventListener('resize', soon);
  document.addEventListener('focusin', soon);
  document.addEventListener('focusout', soon);
}
