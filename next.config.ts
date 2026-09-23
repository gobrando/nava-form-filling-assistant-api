import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The API is the product; there is no UI surface in this service. Keeping
  // `output: 'standalone'` makes the Dockerfile viable for Cloud Run, which is
  // where labs-asp production runs — see README "Deploy target".
  output: 'standalone',
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
