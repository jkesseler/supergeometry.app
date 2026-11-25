/** Set by `run` before the first step of each rebuild; read by the steps. */
export const rebuild = {
  /** The steps of the project being built (a thread's record is only good while its step is there). */
  stepsNow: new Set<string>(),
  /** Steps switched off in this rebuild (a step made from one says so, not "deleted"). */
  switchedOff: new Set<string>()
};
