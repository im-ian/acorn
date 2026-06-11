import type { StorybookConfig } from "@storybook/react-vite";

const tauriOpenerMock = new URL("./mocks/tauri-opener.ts", import.meta.url)
  .pathname;

const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.@(ts|tsx|mdx)"],
  addons: ["@storybook/addon-docs"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal: async (viteConfig) => ({
    ...viteConfig,
    plugins: viteConfig.plugins?.filter(
      (plugin) =>
        !plugin ||
        !("name" in plugin) ||
        plugin.name !== "console-forward",
    ),
    resolve: {
      ...viteConfig.resolve,
      alias: [
        {
          find: "@tauri-apps/plugin-opener",
          replacement: tauriOpenerMock,
        },
        ...(Array.isArray(viteConfig.resolve?.alias)
          ? viteConfig.resolve.alias
          : Object.entries(viteConfig.resolve?.alias ?? {}).map(
              ([find, replacement]) => ({
                find,
                replacement: String(replacement),
              }),
            )),
      ],
    },
    server: {
      ...viteConfig.server,
      port: undefined,
      strictPort: false,
      hmr: undefined,
    },
  }),
};

export default config;
