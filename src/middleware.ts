import { NextRequest, NextResponse } from 'next/server'

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  // Allow APIs, static, admin and auth routes
  if (pathname.startsWith('/_next') || pathname.startsWith('/api') || pathname.startsWith('/admin') || pathname.startsWith('/auth') || pathname.startsWith('/static')) {
    return NextResponse.next()
  }
  if (pathname === '/' || pathname === '') {
    const url = req.nextUrl.clone()
    url.pathname = '/auth/login'
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/((?!_next|api|admin|auth|static).*)'],
}
