# NostrChat deployment

Repository: https://github.com/greyw0rks/nostrchat

Public site: https://nostrchat-greyw0rks.vercel.app/

The standalone Vercel project serves NostrChat at its root. Its build includes only apps/nostrchat; no Finance or other product interface is bundled. The reviewed Convex infrastructure remains shared, with this product's existing isolated tables and wallet scope. Register this site in GREY_ALLOWED_ORIGINS before authenticated use. The public API rewrites to intent-curlew-185.convex.site. Historical evidence keeps its original origins and hashes. New release checks document this standalone snapshot.

Run pnpm build:release to build dist/. Run ./start.sh for the private local lab.

Vercel project: nostrchat-greyw0rks. Deploy the frontend independently with that project. Shared Convex updates must retain the existing Finance, Academy, Sandbox and chat schemas and routes; coordinate backend releases from the current integration snapshot.
