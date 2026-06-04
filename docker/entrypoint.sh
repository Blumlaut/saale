#!/bin/sh
set -e

# Ensure uploads directory exists and is writable by the app user
# Docker named volumes are root-owned by default
mkdir -p /app/uploads
chown -R nextjs:nodejs /app/uploads

# Switch to non-root user, exec dumb-init as PID 1 for proper signal handling
exec su nextjs -s /bin/sh -c "exec dumb-init -- $*"
