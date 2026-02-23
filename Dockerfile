# Dockerfile for Google Cloud Run Jobs deployment
FROM node:20-slim

# Set production environment
ENV NODE_ENV=production

WORKDIR /app

# Copy package files (as root for npm ci)
COPY package*.json ./

# Install production dependencies only (excludes devDependencies like puppeteer, csv-parser)
RUN npm ci --omit=dev

# Copy application code with correct ownership for non-root user
COPY --chown=node:node . .

# Switch to non-root user for security
USER node

# Run the orchestrator as the entry point
CMD ["node", "ats/orchestrator.js"]
