// Workspace path guard switch — sole decision point for whether the
// workspace boundary check is enforced.
//
// Returns true (guard ON) only in safe mode.
// Returns false (guard OFF) in unrestricted mode — selecting unrestricted
// already implies the workspace path boundary is lifted; no secondary
// toggle exists.
//
// All workspace path checks in tools must call this helper. Safe-mode code
// paths remain byte-for-byte identical because the helper returns true and
// the original guard branch runs unchanged.

import { readSettings } from '../settings'

export function isWorkspaceGuardEnabled(): boolean {
  return readSettings().securityMode === 'safe'
}
