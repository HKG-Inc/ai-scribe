import type { NextConfig } from "next";

const basePath = process.env.BASEPATH || "";

const bareAppRoutes = [
  "/login",
  "/signup",
  "/recording",
  "/pricing",
  "/help",
  "/visit-details",
];

const nextConfig: NextConfig = {
  basePath,
  env: {
    NEXT_PUBLIC_BASEPATH: basePath,
  },
  async redirects() {
    if (!basePath) {
      return [];
    }

    return [
      {
        source: "/",
        destination: `${basePath}/login`,
        permanent: false,
        basePath: false,
      },
      ...bareAppRoutes.flatMap((route) => [
        {
          source: route,
          destination: `${basePath}${route}`,
          permanent: false,
          basePath: false,
        },
        {
          source: `${route}/:path*`,
          destination: `${basePath}${route}/:path*`,
          permanent: false,
          basePath: false,
        },
      ]),
    ];
  },
  serverExternalPackages: ["mupdf", "@google-cloud/storage"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "hebbkx1anhila5yf.public.blob.vercel-storage.com",
      },
    ],
  },
};

export default nextConfig;
