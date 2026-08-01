/** @type {import('next').NextConfig} */
export default {
  // The API package is consumed for its AppRouter *type* only; nothing from it
  // is bundled. Kept explicit so a future value import fails loudly at build
  // time rather than silently pulling Fastify into the client graph.
  transpilePackages: [],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};
