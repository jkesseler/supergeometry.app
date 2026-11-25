/** Set by `run` before the first step of each rebuild; read by the steps. */
export const rebuild = {
  /** Steps switched off in this rebuild (a step made from one says so, not "deleted"). */
  switchedOff: new Set<string>()
};
