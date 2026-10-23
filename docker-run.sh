#!/usr/bin/env bash
# Standalone Docker launcher for TimeQuant Email Service (trap)
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DIR}"

ACTION="${1:-up}"

case "${ACTION}" in
  build)
    echo "🔨 Building TimeQuant Email Service Docker image..."
    docker compose build
    ;;
  up|start)
    echo "🚀 Starting TimeQuant Email Service in Docker..."
    docker compose up -d
    echo "✅ Email Service started at http://localhost:3000"
    ;;
  logs)
    docker compose logs -f
    ;;
  down|stop)
    echo "🛑 Stopping TimeQuant Email Service Docker..."
    docker compose down
    ;;
  status)
    docker compose ps
    ;;
  *)
    echo "Usage: $0 {build|up|down|logs|status}"
    exit 1
    ;;
esac

