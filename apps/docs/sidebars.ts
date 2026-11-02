import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    {
      type: "category",
      label: "Tutorials",
      items: ["tutorials/share-your-first-room"],
    },
    {
      type: "category",
      label: "How-to guides",
      items: [
        "how-to/install-the-plugin",
        "how-to/manage-share-links",
        "how-to/choose-a-client-and-relay",
        "how-to/run-your-own-relay",
        "how-to/publish-github-pages",
        "how-to/migrate-hosted-domain",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: ["protocol-v2"],
    },
    {
      type: "category",
      label: "Explanation",
      items: [
        "explanation/architecture",
        "explanation/security-and-privacy",
        "explanation/why-rooms",
      ],
    },
  ],
};

export default sidebars;
