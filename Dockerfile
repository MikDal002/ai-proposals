# Base image: Official Debian Bookworm Slim with Node 20 LTS (glibc compatibility for esbuild)
FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies into container image layer
COPY package.json package-lock.json* ./
RUN npm install

# Copy project source and configuration
COPY . .

# Default command
CMD ["npm", "run", "build"]
