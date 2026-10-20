/** Case-insensitive-ish name ordering shared by every project/suite/case list. */
export function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
