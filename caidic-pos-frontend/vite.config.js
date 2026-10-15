import { defineConfig } from 'vite';

// Relative asset paths, so the build works from any folder, including
// GitHub Pages' https://<user>.github.io/<repo>/.
export default defineConfig({
  base: './',
});
