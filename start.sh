#!/bin/sh

# Start Redis server in the background
redis-server --daemonize yes

# Wait a moment to ensure Redis is up
sleep 2

# Start the Node.js application in the foreground
npm start
