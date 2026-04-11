FROM node:20-slim

WORKDIR /app

# Copy app files
COPY package*.json ./
COPY tsconfig.json ./
COPY next.config.ts ./
COPY postcss.config.mjs ./
COPY eslint.config.mjs ./
COPY src ./src
COPY public ./public

# Install deps
RUN npm install --omit=dev

# Expose port
EXPOSE 3000

# Start app in dev mode (faster)
CMD ["npm", "run", "dev"]
