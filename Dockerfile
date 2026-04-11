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
RUN npm install

# Build app for production
RUN npm run build

# Expose port
EXPOSE 3000

# Start production server
CMD ["npm", "start"]
