import { defineConfig, loadEnv } from 'vite';

// The published app's Content-Security-Policy: it runs only its own files and
// talks only to its own Supabase project, so injected script has nowhere to
// load from or send data to. Build only: the development server needs inline
// styles and a live-reload connection.
function contentSecurityPolicy(supabaseUrl) {
  let supabase = 'https://*.supabase.co';
  try {
    supabase = new URL(supabaseUrl).origin;
  } catch { /* address not set: any Supabase project */ }
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${supabase}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');

  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
  };
}

// Relative asset paths, so the build works from any folder, including
// GitHub Pages' https://<user>.github.io/<repo>/.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [contentSecurityPolicy(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL)],
}));
