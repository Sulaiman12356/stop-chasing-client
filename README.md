# Stop Chasing Clients: sales page and admin

Run locally: `node server.js` then open http://localhost:3000 (sales page) and http://localhost:3000/admin.
Deploy to a Node host with a persistent disk (Render, Railway, a VPS). Set the variables from `.env` in the host settings and set DATA_FILE to a path on the persistent disk. Do not use a serverless host, because orders are saved to a file.
Meta: fill META_PIXEL_ID, META_ACCESS_TOKEN and META_API_VERSION (use the current Graph API version). Purchase is sent server-side only when you confirm an order.
Change the admin password: generate a new scrypt hash and replace ADMIN_PASSWORD_HASH.
Not included: email delivery, protected file links, payment gateways.
See DEPLOY.md for hosting steps.
