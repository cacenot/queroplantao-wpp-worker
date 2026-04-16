export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  const prefix = token.slice(0, 4);
  const suffix = token.slice(-4);
  return `${prefix}...${suffix}`;
}
