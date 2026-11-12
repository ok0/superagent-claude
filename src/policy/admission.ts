// Ported from dsh-superagent-prototype (MIT) src/admission.ts
/**
 * A listed sender who addresses the agent is always explicit (no table cell);
 * an unaddressed message cannot be explicit.
 */
import type { AdmissionCell } from '../core/model.ts'

export type { AdmissionCell }
export type Admission = 'explicit' | 'inferred' | 'ignore'
export const ADMISSION_OPTIONS = {
  listedUnaddressed: ['inferred', 'ignore'],
  unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore'],
} as const satisfies Record<AdmissionCell, readonly Admission[]>
export type AdmissionRow = { [C in AdmissionCell]?: (typeof ADMISSION_OPTIONS)[C][number] }
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = {
  listedUnaddressed: 'inferred',
  unlistedAddressed: 'ignore',
  unlistedUnaddressed: 'ignore',
}
