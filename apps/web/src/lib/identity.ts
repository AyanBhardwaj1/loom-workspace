/**
 * Person colors in print inks. Stored avatar colors (whatever palette the
 * server assigned) are mapped onto a fixed set of process pigments by a
 * stable hash, so every client agrees on a person's color without a data
 * migration. Every ink carries #111 initials at ≥7:1 and none collide with
 * the red signal reserved for liveness.
 */
const INKS = ['#F2C230', '#4FB3D9', '#6BBF59', '#F08A3C', '#F07FA8', '#C9C3B5'] as const

export function identityColor(stored: string | null | undefined): string {
  if (!stored) return INKS[5]
  let h = 0
  for (let i = 0; i < stored.length; i++) h = (Math.imul(31, h) + stored.toLowerCase().charCodeAt(i)) | 0
  return INKS[Math.abs(h) % INKS.length]!
}

/** Modules are numbered units on the print grid: U-01, U-02… (by creation order). */
export function unitCode(modules: Array<{ id: string }>, moduleId: string): string {
  const i = modules.findIndex((m) => m.id === moduleId)
  return `U-${String((i < 0 ? 0 : i) + 1).padStart(2, '0')}`
}
