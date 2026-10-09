FROM node:20-alpine

# Install Redis
RUN apk add --no-cache redis

WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application source
COPY src/ ./src/

# Copy the entrypoint script
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

# Expose API port
EXPOSE 3000

# Start both Redis and Node via the script
CMD ["./start.sh"]
