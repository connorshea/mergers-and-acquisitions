# Toolforge Build Service web process. `toolforge webservice buildservice start`
# runs this. The app listens on $PORT (set by Toolforge) and serves both the API
# and the built SPA from dist/client. Calls `node` directly, not `npm run start`:
# npm 11 refuses to run scripts because devEngines.packageManager names pnpm.
web: node server/index.ts
