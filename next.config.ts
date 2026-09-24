import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The API serves the partner contract. One page, /participate/[token], is the
  // participant check-in: masked facts and open questions, with no submit control.
  output: 'standalone',
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
