/** Application-level error contract used across the new frontend.
 *  Pages/components consume `AppError`; domain adapters map transport /
 *  command failures into it. */
export type AppError = {
  /** Stable code from shared/errors/codes.ts or a domain-specific string. */
  code: string;
  /** User-visible summary (Chinese). */
  message: string;
  /** Optional technical detail for troubleshooting / devtools. never shown
   *  directly to non-technical users and must not contain secrets. */
  detail?: string;
  /** Whether the failing action is safe for the user / UI to retry. */
  retryable: boolean;
};
