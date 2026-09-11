import type { NextConfig } from "next";

const basePath = process.env.BASEPATH || "";

const bareAppRoutes = [
  "/login",
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
    const redirects = [
      {
        source: "/signup",
        destination: `${basePath}/login`,
        permanent: false,
        ...(basePath ? { basePath: false as const } : {}),
      },
      {
        source: "/signup/:path*",
        destination: `${basePath}/login`,
        permanent: false,
        ...(basePath ? { basePath: false as const } : {}),
      },
    ];

    if (!basePath) {
      return redirects;
    }

    return [
      {
        source: "/",
        destination: `${basePath}/login`,
        permanent: false,
        basePath: false as const,
      },
      ...bareAppRoutes.flatMap((route) => [
        {
          source: route,
          destination: `${basePath}${route}`,
          permanent: false,
          basePath: false as const,
        },
        {
          source: `${route}/:path*`,
          destination: `${basePath}${route}/:path*`,
          permanent: false,
          basePath: false as const,
        },
      ]),
      ...redirects,
    ];
  },
  serverExternalPackages: ["mupdf"],
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
