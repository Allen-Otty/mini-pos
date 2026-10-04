# Dogo POS payment server — minimal production image
FROM node:22-alpine
WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# App source
COPY server.js ./
COPY payments ./payments
COPY index.html admin payment-complete.html ./

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/payments/gateways >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
