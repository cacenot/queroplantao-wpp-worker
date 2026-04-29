export function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600_000);
}
