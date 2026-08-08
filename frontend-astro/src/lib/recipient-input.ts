/**
 * Treat any dotted name as a potential ENS name and let the Worker perform
 * ENSIP-15 normalization and authoritative resolution. ENS supports DNS names
 * such as POAP's `name.poap.xyz`, so checking only for `.eth` is incorrect.
 */
export function looksLikeEnsName(value: string): boolean {
  const candidate = value.trim();
  return (
    candidate.includes(".") &&
    !candidate.includes("@") &&
    !candidate.startsWith(".") &&
    !candidate.endsWith(".") &&
    !/\s/u.test(candidate)
  );
}
