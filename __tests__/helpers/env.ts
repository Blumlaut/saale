/**
 * Putting the environment back the way a test found it.
 *
 * `process.env.NAME = undefined` stores the string "undefined", which reads as
 * a value and quietly changes what the next test sees. Restoring through here
 * keeps the two cases apart.
 */

/** Set `name` from `value`, or unset it when there was nothing there. */
export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
