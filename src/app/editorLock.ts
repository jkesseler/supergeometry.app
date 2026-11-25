/** Resolves once this tab may save: no other tab of the app has the project open. `waitForOther` runs while one does. */
export async function holdEditorLock(waitForOther: () => Promise<unknown>): Promise<void> {
  if (!('locks' in navigator)) {
    return;
  }
  while (!(await takeLock())) {
    await waitForOther();
  }
}

function takeLock(): Promise<boolean> {
  return new Promise((resolve) => {
    navigator.locks.request('sg-editor', { ifAvailable: true }, (lock) => {
      resolve(lock !== null);

      // A promise that never settles keeps the lock until the tab closes.
      return lock ? new Promise(() => undefined) : undefined;
    });
  });
}
