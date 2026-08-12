# Cloud Run sets PORT and the server reads it. Nothing to install, since the
# server uses only what ships with Node.
FROM node:22-alpine
WORKDIR /app
COPY server.js .
# Run as a normal user rather than root, so a flaw in the process is contained.
USER node
CMD ["node", "server.js"]
