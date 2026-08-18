/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-window-session`.
 * @module @deepseek-ai/dsh-window-session/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-window-session'

/** Cordis companion plugin name. */
export const name = 'window-session-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * M0 invariant: no runtime invariant yet. Child-window ownership is derived
 * from the live session.cwd lineage enforced by AgentRegistry and the surface
 * reader, not from data this package mutates in place. When window metadata
 * becomes persisted (M1), the installer will assert the lineage relationship.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
