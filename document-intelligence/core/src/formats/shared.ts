/** Shared helpers for format parsers. */
export function partToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function isNumericCell(value: string): boolean {
  if (!value) return false;
  return /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
}

export function toNumber(value: string): number | null {
  if (!isNumericCell(value)) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}
