/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export -> deploy folder `out/` to Firebase Hosting (no server needed)
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
