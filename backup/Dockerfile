# Dedicated backup service container for Paperless DR & Backup (Workstream 2D)
# Base image: hardened, minimal Alpine Linux
FROM alpine:3.20

# Install operational utilities
RUN apk add --no-cache bash curl ca-certificates tzdata

# Create dedicated non-root backup user and group (UID 10001, GID 10001)
RUN addgroup -g 10001 -S backup && \
    adduser -u 10001 -S backup -G backup

# Establish strict directory hierarchy required by backup architecture
# /backup/config     - Backup configuration and runtime options
# /backup/spool      - Persistent staging volume for active backup operations
# /backup/manifests  - Backup manifests and inventory metadata
# /backup/logs       - Operational logging output
# /backup/temporary  - Ephemeral intermediate files
RUN mkdir -p /backup/config \
             /backup/spool \
             /backup/manifests \
             /backup/logs \
             /backup/temporary && \
    chown -R 10001:10001 /backup && \
    chmod -R 750 /backup

USER 10001:10001
WORKDIR /backup

# Maintain background container readiness while respecting OS termination signals
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["trap 'exit 0' TERM INT; sleep infinity & wait"]
