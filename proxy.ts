import { entriesCarryValue } from '@/lib/demo/repair-query';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Drops a repair-desk URL that carries a value before the page renders.
 * The redirect target is a fixed notice, so the value is not copied into the
 * address or the page.
 */
export function proxy(request: NextRequest) {
  if (!entriesCarryValue(request.nextUrl.searchParams.entries())) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.search = '';
  url.searchParams.set('notice', 'rejected');
  return NextResponse.redirect(url);
}

export const config = {
  matcher: '/work/repair',
};
