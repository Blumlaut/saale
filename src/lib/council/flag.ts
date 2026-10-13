/**
 * The council kill switch.
 *
 * `COUNCIL_ENABLED=0` removes the module from the app: the nav entry is not
 * rendered, every `/api/council` route answers 404 and no council tool is
 * built. Together with `src/lib/council/README.md` (the rip-out list) it is
 * what makes the module optional rather than load-bearing.
 *
 * The switch is deliberately unset-by-default-on: the sidebar entry is hidden
 * until the user enables it (see `SidebarNavItem.defaultHidden`), so the
 * feature is already invisible without the variable.
 *
 * Pure — no database or Node-only imports, so any layer can read it.
 */
export function isCouncilEnabled(): boolean {
  return process.env.COUNCIL_ENABLED !== "0";
}
