import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            // Firebase Auth loads Google API and reCAPTCHA scripts.
            // Inline scripts, including the Netlify badge frame, stay blocked.
            value: "script-src 'self' https://apis.google.com https://www.gstatic.com https://www.google.com/recaptcha/",
          },
        ],
      },
    ]
  },
}

export default nextConfig
