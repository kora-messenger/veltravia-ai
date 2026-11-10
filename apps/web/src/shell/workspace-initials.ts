/**
 * The two letters a workspace wears, the way the reference derives them: the
 * first letter of its first two words, so "Ijezie's Workspace" reads IW and
 * "Personal workspace" reads PW. One letter would look like a person, not a
 * place; three would not fit an avatar this size.
 */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? '');
  return letters.join('').toUpperCase();
}
