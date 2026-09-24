/**
 * What the repair desk is willing to read from a URL.
 *
 * `form` picks the open page. `notice` is one of the desk's own outcomes.
 * Anything else is treated as a household value and refused, without the
 * value being copied into the response.
 */

export type RepairQuery = Record<string, string | string[] | undefined>;

export const VALUE_REJECTION =
  'This page was not opened. The request included a value, and this desk only reads selectors and labels. Open the form again without it.';

const FORMS = new Set(['wic', 'ihss']);
const NOTICES = new Set(['saved', 'refused', 'needs-database', 'rejected']);

export function queryCarriesValue(query: RepairQuery): boolean {
  const entries: [string, string][] = [];
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    for (const value of values) entries.push([key, value]);
  }
  return entriesCarryValue(entries);
}

export function entriesCarryValue(entries: Iterable<[string, string]>): boolean {
  for (const [key, value] of entries) {
    if (key === 'form') {
      if (!FORMS.has(value)) return true;
      continue;
    }
    if (key === 'notice') {
      if (!NOTICES.has(value)) return true;
      continue;
    }
    return true;
  }
  return false;
}
