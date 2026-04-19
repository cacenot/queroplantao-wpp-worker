import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.byteLength !== bufB.byteLength) {
    // Dummy compare para manter custo constante independente do length.
    cryptoTimingSafeEqual(bufA, bufA);
    return false;
  }

  return cryptoTimingSafeEqual(bufA, bufB);
}
