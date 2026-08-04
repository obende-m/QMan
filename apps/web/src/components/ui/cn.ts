/**
 * Minimal class-name joiner. Deliberately not `clsx` + `tailwind-merge`: the
 * components here own their own classes and never receive conflicting overrides,
 * so two dependencies would buy nothing.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
