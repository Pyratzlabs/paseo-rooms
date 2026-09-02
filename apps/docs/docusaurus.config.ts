import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Paseo Rooms",
  tagline: "Collaborative agent work",
  favicon: "img/favicon.svg",
  url: "https://paseo-rooms.pyratzlabs.fr",
  baseUrl: "/docs/",
  organizationName: "pyratzlabs",
  projectName: "paseo-rooms",
  onBrokenLinks: "throw",
  markdown: { hooks: { onBrokenMarkdownLinks: "throw" } },
  i18n: { defaultLocale: "en", locales: ["en"] },
  presets: [
    [
      "classic",
      {
        docs: {
          path: "../../docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          exclude: ["design.md", "plan.md", "web-ui.md"],
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    navbar: {
      title: "Paseo Rooms",
      logo: { alt: "Paseo Rooms", src: "img/logo.svg" },
      items: [
        { to: "/", label: "Documentation", position: "left" },
        {
          href: "https://paseo-rooms.pyratzlabs.fr/",
          label: "Product",
          position: "right",
        },
        {
          href: "https://gitlab.com/pyratzlabs/software/paseo-rooms",
          label: "Source",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Paseo Rooms",
          items: [
            { label: "Start sharing", to: "/tutorials/share-your-first-room" },
          ],
        },
        {
          title: "Project",
          items: [
            {
              label: "Source",
              href: "https://gitlab.com/pyratzlabs/software/paseo-rooms",
            },
            {
              label: "AGPL-3.0-or-later",
              href: "https://www.gnu.org/licenses/agpl-3.0.en.html",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Pyratz Labs.`,
    },
    prism: {
      theme: { plain: {}, styles: [] },
      darkTheme: { plain: {}, styles: [] },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
