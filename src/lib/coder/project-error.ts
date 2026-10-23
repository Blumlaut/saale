/**
 * A project operation the route can report as-is. `status` is the HTTP code.
 *
 * Declared here rather than beside the project queries so the modules that
 * validate a project's settings can refuse without importing the query layer.
 */
export class CoderProjectError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "CoderProjectError";
  }
}
