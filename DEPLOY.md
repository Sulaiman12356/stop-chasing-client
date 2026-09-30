# Deploying Stop Chasing Clients

The app needs a Node host with a persistent disk, because orders are saved to a file. A plan without a disk loses your orders on every restart.

## Option A: Render
1. Create a private GitHub repository and upload everything in this folder. Do NOT upload any .env file or deployment-secrets.txt. (.gitignore already blocks .env and data.json.)
2. On render.com choose New, then Blueprint, and select the repository. It reads render.yaml and creates a web service with a 1 GB disk (a paid plan; check current pricing).
3. When asked for the secret variables, paste from deployment-secrets.txt: ADMIN_PASSWORD_HASH, SESSION_SECRET and SITE_URL (your live https address).
4. Deploy, then open the address Render gives you, and /admin for the dashboard.
5. To use your own domain, add it under Settings, Custom Domains, then update SITE_URL.

## Option B: a VPS
Install Node 18 or newer, upload the folder, create .env from .env.example using the values in deployment-secrets.txt, run `node server.js` under pm2 or systemd, and put Caddy or Nginx in front for HTTPS.

## Test before running ads
1. Submit the form with your own details and confirm the payment screen appears.
2. Tap the WhatsApp button. A message with your details should open.
3. Log in at /admin. The order, WhatsApp click and funnel counts should appear.
4. Set the order to PAYMENT_CONFIRMED. Revenue and purchases should update once.
5. In Meta Events Manager, open Test Events and check PageView, Lead, InitiateCheckout, Contact and Purchase.
6. Set your test order to CANCELLED so it does not count as a real sale.

## Keep it safe
Export the orders CSV weekly as a backup. To change the admin password, replace ADMIN_PASSWORD_HASH. Replace the privacy, terms and refund placeholders in public/index.html before launch.
