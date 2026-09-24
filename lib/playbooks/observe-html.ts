import type { ObservedControl } from './scribe';

/**
 * Reads controls out of a local HTML fixture.
 *
 * The partner who has the county page open sends this same shape from that
 * page. This parser exists so a rehearsal can build the observation from the
 * fixture without a browser. It does not fetch anything.
 */
export function observeHtml(html: string): ObservedControl[] {
  const labels = new Map<string, string>();
  for (const match of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/gi)) {
    const text = match[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    labels.set(match[1], text);
  }

  const counts = new Map<string, number>();
  const found: ObservedControl[] = [];
  for (const match of html.matchAll(/<(input|select|textarea|button)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? '';
    const id = /(?:^|\s)id="([^"]+)"/i.exec(attrs)?.[1];
    if (!id) continue;
    const typeAttr = /(?:^|\s)type="([^"]+)"/i.exec(attrs)?.[1]?.toLowerCase();
    const type =
      tag === 'select'
        ? 'select'
        : tag === 'textarea'
          ? 'textarea'
          : tag === 'button'
            ? (typeAttr ?? 'submit')
            : (typeAttr ?? 'text');
    const selector = `#${id}`;
    counts.set(selector, (counts.get(selector) ?? 0) + 1);
    found.push({
      selector,
      label: labels.get(id) ?? '',
      type,
      required: /\brequired\b/i.test(attrs),
      count: 1,
    });
  }

  return found.map((control) => ({ ...control, count: counts.get(control.selector) ?? 1 }));
}
