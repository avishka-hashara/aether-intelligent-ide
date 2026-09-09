/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        vscode: {
          bg: "var(--vscode-editor-background, #1e1e1e)",
          fg: "var(--vscode-editor-foreground, #cccccc)",
          sidebar: "var(--vscode-sideBar-background, #252526)",
          card: "#252526",
          border: "var(--vscode-panel-border, #333333)",
          accent: "var(--vscode-focusBorder, #007acc)",
          badge: "#3a3d41",
        },
      },
    },
  },
  plugins: [],
};
