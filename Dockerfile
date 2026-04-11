FROM node:20-slim

WORKDIR /app

# NEXT_PUBLIC_* variables must exist at build time for client bundle replacement.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

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
